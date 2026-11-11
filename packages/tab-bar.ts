// Tabs, after Emacs's tab-bar.el: each frame has a list of tabs, each a
// window configuration with a name. C-x t 2 opens a tab, C-x t o and
// C-<tab> go to the next, C-x t 0 closes one and C-x t RET switches by
// name. With tab-bar-mode on, a bar across the top of each frame shows the
// tabs, the current one standing out; a click selects a tab, closes it with
// its "x", or opens one with "+". tab-bar-history-mode keeps each tab's
// earlier window configurations, for C-c <left> and C-c <right>.

import { forwardLine, truthy } from "subr";

// --- Faces and options ------------------------------------------------------

e8.defineFace({ name: "tab-bar", doc: "The tab bar, across the top of a frame." });
e8.defineFace({ name: "tab-bar-tab", doc: "The selected tab on the tab bar.", attributes: { inherit: "tab-bar" } });
e8.defineFace({ name: "tab-bar-tab-inactive", doc: "The tabs on the tab bar that are not selected.", attributes: { inherit: "tab-bar-tab" } });

for (const [name, value, doc] of [
  ["tab-bar-show", true, "When the tab bar shows: t always, once tab-bar-mode is on; a number, when there are more tabs than that; nil never."],
  [
    "tab-bar-new-tab-choice",
    true,
    'What a new tab shows: t the current buffer, "window" the selected window, "clone" a copy of the current tab, a buffer name or file, or a function giving a buffer.',
  ],
  ["tab-bar-new-tab-to", "right", 'Where a new tab goes: "leftmost", "left", "right" or "rightmost".'],
  ["tab-bar-close-button-show", true, 'Which tabs show their close button "x": t all, "selected", "non-selected", or nil none.'],
  ["tab-bar-tab-hints", false, "Whether each tab shows its number before its name, to select it by."],
  ["tab-bar-separator", null, "What goes between tabs: nil for a space, or a bar on a terminal."],
  ["tab-bar-tab-name-function", "tab-bar-tab-name-current", "The function that names a tab whose name was not given, called with no arguments."],
  ["tab-bar-tab-name-truncated-max", 20, "How long tab-bar-tab-name-truncated lets a name be."],
  ["tab-bar-close-tab-select", "recent", 'Which tab is selected after closing the current one: "left", "right" or "recent".'],
  ["tab-bar-close-last-tab-choice", null, 'What closing the last tab does: nil nothing, "delete-frame", or "tab-bar-mode-disable".'],
  [
    "tab-bar-format",
    ["tab-bar-format-history", "tab-bar-format-tabs", "tab-bar-separator", "tab-bar-format-add-tab"],
    "What the tab bar shows, in order: functions giving its items, such as tab-bar-format-tabs.",
  ],
  ["tab-bar-auto-width", true, "Whether tabs are made one width, wide enough to fill the tab bar within tab-bar-auto-width-max."],
  ["tab-bar-auto-width-max", [[220], 20], "The widest tabs auto-width makes: in pixels on a graphical display, the first, and in columns on a terminal."],
  ["tab-bar-auto-width-min", [[20], 2], "The narrowest tabs auto-width makes, as tab-bar-auto-width-max."],
  ["tab-bar-history-limit", 10, "How many window configurations tab-bar-history-mode keeps for each tab."],
  ["tab-bar-new-button", " + ", "The button that opens a new tab."],
  ["tab-bar-close-button", " x", "The button that closes a tab."],
  ["tab-bar-back-button", " < ", "The button that goes back in the tab's history."],
  ["tab-bar-forward-button", " > ", "The button that goes forward in the tab's history."],
] as const) {
  e8.defineVariable({ name, value: value as e8.Value, doc });
}
e8.defineHook("tab-bar-tab-post-open-functions", "Functions called with the new tab's name after a tab is made.");
e8.defineHook("tab-bar-tab-post-select-functions", "Functions called after selecting a tab, with the names of the tab left and the tab selected.");
e8.defineHook("tab-bar-tab-pre-close-functions", "Functions called with the name of a tab about to be closed, and whether it is the frame's only one.");

// --- Tabs -------------------------------------------------------------------

/** A window configuration and where point was in it, as a tab's wc and wc-point. */
interface Saved {
  wc: e8.WindowConfiguration;
  point: e8.Marker;
}

interface Tab {
  /** Its id, which the tab switcher's lines carry. */
  id: number;
  name: string;
  /** Whether its name was given, rather than made by tab-bar-tab-name-function. */
  explicitName: boolean;
  /** When it was last left, for the most recent tab. */
  time: number;
  current: boolean;
  /** Its windows, while it is not current. */
  saved?: Saved;
  /** Its window history, while it is not current, as wc-history-back and -forward. */
  back?: Saved[];
  forward?: Saved[];
}

let nextId = 1;
/** Counts tab changes, for ordering tabs by when they were last left, as their float-time does. */
let clock = 0;
/** Each frame's tabs, as the `tabs` frame parameter holds them. */
const frameTabs = new Map<e8.Frame, Tab[]>();
/** Closed tabs, newest first, for tab-undo, as tab-bar-closed-tabs. */
const closedTabs: { frame: e8.Frame; index: number; tab: Tab }[] = [];

/** The name tab-bar-tab-name-function gives the current tab. */
function autoName(): string {
  const fn = e8.variable("tab-bar-tab-name-function");
  const name = typeof fn === "string" || typeof fn === "function" ? e8.funcall(fn as string) : undefined;
  return typeof name === "string" ? name : currentName();
}

/** The name of the buffer a tab is named after: the window's the minibuffer was entered from, while it is open, as Emacs's tab-bar names do. */
function currentName(): string {
  return e8.windowBuffer(e8.minibufferSelectedWindow() ?? e8.selectedWindow()) ?? "";
}

e8.defun("tab-bar-tab-name-current", () => currentName());
e8.defun("tab-bar-tab-name-current-with-count", () => {
  const count = e8.windowList().length;
  const name = currentName();
  return count > 1 ? `${name} (${count})` : name;
});
e8.defun("tab-bar-tab-name-all", () => [...new Set(e8.windowList().map((w) => e8.windowBuffer(w)))].join(", "));
e8.defun("tab-bar-tab-name-truncated", () => {
  const name = currentName();
  const max = Number(e8.variable("tab-bar-tab-name-truncated-max") ?? 20);
  return [...name].length < max ? name : `${[...name].slice(0, max - 1).join("")}…`;
});

/** A frame's tabs, the selected frame's by default, made with one current tab if it has none, as tab-bar-tabs. */
function tabs(frame = e8.selectedFrame()): Tab[] {
  let list = frameTabs.get(frame);
  if (!list) {
    list = [{ id: nextId++, name: frame === e8.selectedFrame() ? autoName() : "", explicitName: false, time: ++clock, current: true }];
    frameTabs.set(frame, list);
    e8.runHooks("tab-bar-tab-post-open-functions", list[0].name);
  } else if (frame === e8.selectedFrame()) {
    const current = list.find((t) => t.current);
    if (current && !current.explicitName) current.name = autoName();
  }
  return list;
}

const currentIndex = (list: Tab[]): number => Math.max(0, list.findIndex((t) => t.current));

/** Where point is now, kept as a marker. */
const pointMarker = (): e8.Marker => e8.makeMarker(e8.point());

/** The current windows, kept for the tab being left, as tab-bar--tab does. */
function leave(tab: Tab): void {
  tab.saved = { wc: e8.currentWindowConfiguration(), point: pointMarker() };
  tab.time = ++clock;
  tab.current = false;
  if (historyMode()) {
    tab.back = history(e8.selectedFrame()).back;
    tab.forward = history(e8.selectedFrame()).forward;
  }
}

/** Puts saved windows back, with point in the buffer that is current then. */
function restore(saved: Saved): void {
  e8.setWindowConfiguration(saved.wc);
  if (e8.markerBuffer(saved.point) === e8.currentBuffer().name) e8.gotoChar(e8.markerPosition(saved.point)!);
}

/** The tabs ordered by when they were last left, most recent first, the current one left out, as tab-bar--tabs-recent. */
const recentTabs = (list: Tab[]): Tab[] => list.filter((t) => !t.current).sort((a, b) => b.time - a.time);

// --- Showing the tab bar ----------------------------------------------------

/** An item on the tab bar: its text and face, and what a click on it does. */
interface Item {
  text: string;
  face?: string;
  /** A tab's number, from 1, for a click to select or close it. */
  tab?: number;
  /** The command a click runs, for a button. */
  command?: string;
}

/** Each frame's items as last shown, each with the columns it takes, for clicks. */
const shownItems = new Map<e8.Frame, { item: Item; from: number; to: number; closeFrom?: number }[]>();

const separator = (): string => {
  const sep = e8.variable("tab-bar-separator");
  return typeof sep === "string" ? sep : e8.displayGraphicP() ? " " : "|";
};

/** A tab's name as the tab bar shows it, as tab-bar-tab-name-format-default with its hints and close button. */
function formatTabName(tab: Tab, i: number): { text: string; close: string } {
  const hints = truthy(e8.variable("tab-bar-tab-hints"));
  const show = e8.variable("tab-bar-close-button-show");
  const closeShown = truthy(show) && show !== (tab.current ? "non-selected" : "selected");
  const close = closeShown ? String(e8.variable("tab-bar-close-button") ?? " x") : "";
  return { text: `${hints ? `${i} ` : ""}${tab.name}`, close };
}

const formats: { [name: string]: (frame: e8.Frame) => Item[] } = {
  "tab-bar-format-history": () =>
    historyMode()
      ? [
          { text: separator() },
          { text: String(e8.variable("tab-bar-back-button") ?? " < "), command: "tab-bar-history-back" },
          { text: separator() },
          { text: String(e8.variable("tab-bar-forward-button") ?? " > "), command: "tab-bar-history-forward" },
        ]
      : [],
  "tab-bar-format-tabs": (frame) =>
    tabs(frame).flatMap((tab, k) => {
      const { text, close } = formatTabName(tab, k + 1);
      return [{ text: separator() }, { text: text + close, face: tab.current ? "tab-bar-tab" : "tab-bar-tab-inactive", tab: k + 1 }];
    }),
  "tab-bar-separator": () => [{ text: separator() }],
  "tab-bar-format-add-tab": () => [{ text: String(e8.variable("tab-bar-new-button") ?? " + "), command: "tab-bar-new-tab" }],
};

/** What the width limits say for this display: the pixel width over the default font's for a graphical one. */
function autoWidthLimit(name: string): number | undefined {
  const value = e8.variable(name);
  if (!Array.isArray(value)) return undefined;
  if (!e8.displayGraphicP()) return Number(value[1]);
  const pixels = Array.isArray(value[0]) ? Number(value[0][0]) : Number(value[0]);
  return Math.floor(pixels / Math.max(1, e8.frameCharWidth()));
}

/**
 * Pads or cuts the tabs' names to one width, as tab-bar-auto-width does:
 * what the frame leaves after the other items, shared out, within the
 * limits; spaces go before the close button, and a cut name ends shadowed.
 */
function autoWidth(items: Item[], frame: e8.Frame): { item: Item; shadowFrom?: number; closeLength: number }[] {
  const tabItems = items.filter((i) => i.tab !== undefined);
  const others = items.filter((i) => i.tab === undefined).reduce((n, i) => n + e8.stringWidth(i.text), 0);
  let width = tabItems.length ? Math.floor((e8.frameWidth(frame) - others) / tabItems.length) : 0;
  const min = autoWidthLimit("tab-bar-auto-width-min");
  const max = autoWidthLimit("tab-bar-auto-width-max");
  if (min !== undefined) width = Math.max(width, min);
  if (max !== undefined) width = Math.min(width, max);
  const close = String(e8.variable("tab-bar-close-button") ?? " x");
  return items.map((item) => {
    const closeLength = item.tab !== undefined && item.text.endsWith(close) && formatTabName(tabs(frame)[item.tab - 1], item.tab).close ? [...close].length : 0;
    if (item.tab === undefined || !truthy(e8.variable("tab-bar-auto-width"))) return { item, closeLength };
    let chars = [...item.text];
    const at = chars.length - closeLength;
    if (e8.stringWidth(item.text) < width) {
      // Spaces before the close button while it stays narrower than the width.
      while (e8.stringWidth(chars.join("")) + 1 < width) chars.splice(chars.length - closeLength, 0, " ");
      return { item: { ...item, text: chars.join("") }, closeLength };
    }
    let shadowFrom: number | undefined;
    if (e8.stringWidth(item.text) > width) {
      while (e8.stringWidth(chars.join("")) > width && chars.length > closeLength) chars.splice(chars.length - closeLength - 1, 1);
      chars = chars.slice();
      shadowFrom = Math.max(0, chars.length - closeLength - 2);
      void at;
    }
    return { item: { ...item, text: chars.join("") }, shadowFrom, closeLength };
  });
}

/** A frame's tab bar from tab-bar-format, as tab-bar-make-keymap-1 builds it at redisplay. */
function tabBarLine(frame: e8.Frame): string | e8.PropertizedString {
  const format = e8.variable("tab-bar-format");
  const items = (Array.isArray(format) ? format : []).flatMap((f) => {
    if (typeof f === "string" && formats[f]) return formats[f](frame);
    if (typeof f === "string" || typeof f === "function") {
      const text = e8.funcall(f as string);
      return typeof text === "string" ? [{ text }] : [];
    }
    return [];
  });
  let line: string | e8.PropertizedString = "";
  const shown: { item: Item; from: number; to: number; closeFrom?: number }[] = [];
  let column = 0;
  for (const { item, shadowFrom, closeLength } of autoWidth(items, frame)) {
    const chars = [...item.text];
    const face = item.face ?? "tab-bar";
    const parts =
      shadowFrom === undefined
        ? [e8.propertize(item.text, { face })]
        : [
            e8.propertize(chars.slice(0, shadowFrom).join(""), { face }),
            e8.propertize(chars.slice(shadowFrom, chars.length - closeLength).join(""), { face: ["shadow", face] }),
            e8.propertize(chars.slice(chars.length - closeLength).join(""), { face }),
          ];
    line = e8.concat(line, ...parts);
    const width = e8.stringWidth(item.text);
    const closeFrom = closeLength ? column + width - e8.stringWidth(chars.slice(chars.length - closeLength).join("")) : undefined;
    shown.push({ item, from: column, to: column + width, closeFrom });
    column += width;
  }
  shownItems.set(frame, shown);
  return line;
}

/** Whether a frame shows the tab bar, as tab-bar--tab-bar-lines-for-frame decides. */
function tabBarLinesFor(frame: e8.Frame): number {
  if (!truthy(e8.variable("tab-bar-mode"))) return 0;
  const show = e8.variable("tab-bar-show");
  if (!truthy(show)) return 0;
  if (typeof show === "number") return tabs(frame).length > show ? 1 : 0;
  return 1;
}

/** Shows or hides each frame's tab bar, and brings what it shows up to date. */
function update(): void {
  for (const frame of e8.frameList()) {
    const lines = tabBarLinesFor(frame);
    if (e8.frameParameter(frame, "tab-bar-lines") !== lines) e8.setFrameParameter(frame, "tab-bar-lines", lines);
    // Formatted at each redisplay, so it shows the tabs as they are then.
    if (lines > 0 && e8.frameParameter(frame, "tab-bar-line") === undefined) {
      e8.setFrameParameter(frame, "tab-bar-line", [Symbol.for(":eval"), () => tabBarLine(frame)] as unknown as e8.Value);
    }
  }
}

e8.addHook("post-command-hook", () => {
  if (truthy(e8.variable("tab-bar-mode"))) update();
});

const tabBarMode = e8.defineMinorMode({
  name: "tab-bar-mode",
  global: true,
  doc:
    "Show a tab bar across the top of each frame: a row of tabs, each a window configuration, that a click selects. " +
    'Its "x" closes a tab and "+" opens one. C-<tab> and C-S-<tab> go to the next and previous tabs.',
  onChange: () => update(),
});

/** Turns tab-bar-mode on if tab-bar-show says to, else updates the bar, as making a tab does. */
function showAfterChange(): void {
  if (truthy(e8.variable("tab-bar-show")) && !truthy(e8.variable("tab-bar-mode"))) e8.callWithPrefix(1, tabBarMode);
  else update();
}

// --- Selecting tabs ---------------------------------------------------------

/** Selects tab `n`, counted from 1, negative from the end, as tab-bar-select-tab. */
function selectTab(n: number): void {
  const list = tabs();
  const from = currentIndex(list);
  const to = Math.max(1, Math.min(n < 0 ? list.length + 1 + n : n === 0 ? from + 1 : n, list.length)) - 1;
  if (from === to) return;
  const fromTab = list[from];
  const toTab = list[to];
  leave(fromTab);
  if (toTab.saved) restore(toTab.saved);
  toTab.saved = undefined;
  toTab.current = true;
  if (historyMode()) {
    const h = history(e8.selectedFrame());
    h.back = toTab.back ?? [];
    h.forward = toTab.forward ?? [];
    historyOmit = true;
  }
  toTab.back = toTab.forward = undefined;
  if (!toTab.explicitName) toTab.name = autoName();
  if (!truthy(e8.variable("tab-bar-mode"))) e8.message(`Selected tab '${toTab.name}'`);
  e8.runHooks("tab-bar-tab-post-select-functions", fromTab.name, toTab.name);
  update();
}

const selectTabCommand = e8.defineCommand({
  name: "tab-bar-select-tab",
  doc: "Select a tab by its number on the tab bar, from 1; negative counts from the end. Bound to a digit, the digit says.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n) => {
    if (typeof n === "number") return selectTab(n);
    const key = e8.lastKey() ?? "";
    const digit = /([1-9])$/.exec(key);
    selectTab(digit ? Number(digit[1]) : 0);
  },
});

const nextTab = e8.defineCommand({
  name: "tab-bar-switch-to-next-tab",
  doc: "Select the next tab, or the one that many on with a prefix argument, round to the first after the last.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => {
    const list = tabs();
    const to = (((currentIndex(list) + arg) % list.length) + list.length) % list.length;
    selectTab(to + 1);
  },
});

const prevTab = e8.defineCommand({
  name: "tab-bar-switch-to-prev-tab",
  doc: "Select the previous tab, or the one that many back with a prefix argument.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => e8.callWithPrefix(-arg, nextTab),
});

const lastTab = e8.defineCommand({
  name: "tab-bar-switch-to-last-tab",
  doc: "Select the last tab, or the one that many from the end with a prefix argument.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => selectTab(tabs().length - (Math.abs(arg) - 1)),
});

const recentTab = e8.defineCommand({
  name: "tab-bar-switch-to-recent-tab",
  doc: "Select the tab used most recently before this one, or the one that many back in recency with a prefix argument.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => {
    const list = tabs();
    const tab = recentTabs(list)[arg - 1];
    if (tab) selectTab(list.indexOf(tab) + 1);
    else e8.message("No more recent tabs");
  },
});

const switchTab = e8.defineCommand({
  name: "tab-bar-switch-to-tab",
  doc: "Select the tab of a name, the most recent ones offered first; a name no tab has makes a new tab of that name.",
  params: [
    {
      name: "name",
      prompt: () => {
        const recent = recentTabs(tabs())[0];
        return recent ? `Switch to tab by name (default ${recent.name}): ` : "Switch to tab by name: ";
      },
      collection: () => recentTabs(tabs()).map((t) => t.name),
    },
  ],
  run: (name) => {
    const list = tabs();
    const wanted = name === "" ? recentTabs(list)[0]?.name : name;
    const index = list.findIndex((t) => t.name === wanted);
    if (index >= 0) selectTab(index + 1);
    else {
      newTabTo();
      renameTab(name);
    }
  },
});

// --- Making, moving, renaming and closing tabs -------------------------------

/** Makes a new tab at position `n`, counted from 1, or where tab-bar-new-tab-to says, as tab-bar-new-tab-to. */
function newTabTo(n?: number): void {
  const list = tabs();
  const from = currentIndex(list);
  const fromTab = list[from];
  const choice = e8.variable("tab-bar-new-tab-choice");
  const clone = choice === "clone" ? e8.currentWindowConfiguration() : undefined;
  leave(fromTab);
  if (truthy(choice)) {
    if (clone) e8.setWindowConfiguration(clone);
    else e8.call("delete-other-windows");
    let buffer: string | undefined;
    if (typeof choice === "function") buffer = String(e8.funcall(choice as unknown as string));
    else if (typeof choice === "string" && choice !== "clone" && choice !== "window") {
      buffer = e8.getBuffer(choice)?.name ?? e8.findFileNoselect(choice);
    }
    if (buffer !== undefined && e8.bufferLiveP(e8.getBuffer(buffer))) e8.call("switch-to-buffer", buffer);
  }
  const tab: Tab = { id: nextId++, name: autoName(), explicitName: false, time: ++clock, current: true };
  const where = e8.variable("tab-bar-new-tab-to");
  let to =
    n !== undefined
      ? n < 0
        ? list.length + 1 + n
        : n - 1
      : where === "leftmost"
        ? 0
        : where === "rightmost"
          ? list.length
          : where === "left"
            ? from
            : from + 1;
  to = Math.max(0, Math.min(to, list.length));
  list.splice(to, 0, tab);
  if (historyMode()) {
    const h = history(e8.selectedFrame());
    h.back = [];
    h.forward = [];
    historyOmit = true;
  }
  e8.runHooks("tab-bar-tab-post-open-functions", tab.name);
  showAfterChange();
  if (!truthy(e8.variable("tab-bar-mode"))) e8.message(`Added new tab at ${String(where)}`);
}

const newTab = e8.defineCommand({
  name: "tab-bar-new-tab",
  doc:
    "Make a new tab, showing what tab-bar-new-tab-choice says, where tab-bar-new-tab-to says; with a prefix argument, " +
    "that many places right of the current tab, or left if negative.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    if (arg === null || arg === undefined) return newTabTo();
    const list = tabs();
    newTabTo(currentIndex(list) + 1 + e8.prefixNumericValue(arg));
  },
});

const newTabToCommand = e8.defineCommand({
  name: "tab-bar-new-tab-to",
  doc: "Make a new tab at a position on the tab bar, from 1, which a prefix argument gives; negative counts from the end.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n) => newTabTo(n === null || n === undefined ? undefined : e8.prefixNumericValue(n)),
});

const duplicateTab = e8.defineCommand({
  name: "tab-bar-duplicate-tab",
  doc: "Make a new tab showing the same windows as the current one.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => e8.letBind({ "tab-bar-new-tab-choice": "clone" }, () => e8.callWithPrefix(arg, newTab)),
});

/** Gives tab `n`, the current one by default, a name, or back its automatic name if empty, as tab-bar-rename-tab. */
function renameTab(name: string, n?: number): void {
  const list = tabs();
  const tab = list[n === undefined ? currentIndex(list) : Math.max(0, Math.min(n, list.length) - 1)];
  tab.explicitName = name !== "";
  tab.name = name !== "" ? name : tab.current ? autoName() : tab.name;
  update();
  if (!truthy(e8.variable("tab-bar-mode"))) e8.message(`Renamed tab to '${tab.name}'`);
}

const renameTabCommand = e8.defineCommand({
  name: "tab-bar-rename-tab",
  doc: "Name the current tab, or the tab a prefix argument numbers. An empty name gives it back its automatic name.",
  params: [
    {
      name: "name",
      prompt: "New name for tab (leave blank for automatic naming): ",
    },
    { name: "n", kind: "prefix" },
  ],
  run: (name, n) => renameTab(name, n === null || n === undefined ? undefined : e8.prefixNumericValue(n)),
});

/** Moves tab `from`, the current one by default, to position `to`, both from 1, as tab-bar-move-tab-to. */
function moveTabTo(to: number, from?: number): void {
  const list = tabs();
  const fromIndex = from === undefined ? currentIndex(list) : from - 1;
  const [tab] = list.splice(fromIndex, 1);
  const target = to < 0 ? list.length + 2 + to : to;
  list.splice(Math.max(0, Math.min(target - 1, list.length)), 0, tab);
  update();
}

const moveTabToCommand = e8.defineCommand({
  name: "tab-bar-move-tab-to",
  doc: "Move the current tab to a position on the tab bar, from 1, which a prefix argument gives; negative counts from the end.",
  params: [{ name: "to", kind: "count" }],
  run: (to) => moveTabTo(to),
});

const moveTab = e8.defineCommand({
  name: "tab-bar-move-tab",
  doc: "Move the current tab one place right, or that many with a prefix argument, left if negative.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => {
    const list = tabs();
    const from = currentIndex(list);
    moveTabTo((((from + arg) % list.length) + list.length) % list.length + 1, from + 1);
  },
});

e8.defineCommand({
  name: "tab-bar-move-tab-backward",
  doc: "Move the current tab one place left, or that many with a prefix argument.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => e8.callWithPrefix(-arg, moveTab),
});

/** Closes tab `n`, the current one by default, then selecting `to` or the one tab-bar-close-tab-select says, as tab-bar-close-tab. */
function closeTab(n?: number, to?: number): void {
  let list = tabs();
  const current = currentIndex(list);
  const index = n === undefined ? current : n - 1;
  const last = list.length === 1;
  e8.runHooks("tab-bar-tab-pre-close-functions", list[index].name, last);
  if (last) {
    const choice = e8.variable("tab-bar-close-last-tab-choice");
    if (choice === "delete-frame") e8.deleteFrame();
    else if (choice === "tab-bar-mode-disable") e8.callWithPrefix(-1, tabBarMode);
    else if (typeof choice === "function" || (typeof choice === "string" && choice !== "")) e8.funcall(choice as string, list[index].name);
    else e8.userError("Attempt to delete the sole tab in a frame");
    return;
  }
  if (index === current) {
    const select = e8.variable("tab-bar-close-tab-select");
    let next =
      to !== undefined
        ? to - 1
        : select === "left"
          ? current < 1
            ? 1
            : current - 1
          : select === "right"
            ? list.length > current + 1
              ? current + 1
              : current - 1
            : list.indexOf(recentTabs(list)[0]);
    next = Math.max(0, Math.min(next, list.length - 1));
    e8.letBind({ "inhibit-message": true }, () => selectTab(next + 1));
    list = tabs();
  }
  const tab = list[index];
  if (tab.current) leave(tab);
  closedTabs.unshift({ frame: e8.selectedFrame(), index, tab });
  list.splice(index, 1);
  update();
  if (!truthy(e8.variable("tab-bar-mode"))) e8.message(`Deleted tab and switched to ${String(e8.variable("tab-bar-close-tab-select"))}`);
}

const closeTabCommand = e8.defineCommand({
  name: "tab-bar-close-tab",
  doc: "Close the current tab, or the tab a prefix argument numbers, selecting the one tab-bar-close-tab-select says.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n) => closeTab(typeof n === "number" ? n : undefined),
});

e8.defineCommand({
  name: "tab-bar-close-tab-by-name",
  doc: "Close the tab of a name.",
  params: [{ name: "name", prompt: "Close tab by name: ", collection: () => tabs().map((t) => t.name), requireMatch: true }],
  run: (name) => closeTab(tabs().findIndex((t) => t.name === name) + 1),
});

const closeOtherTabs = e8.defineCommand({
  name: "tab-bar-close-other-tabs",
  doc: "Close every tab of the frame but the current one.",
  run: () => {
    const list = tabs();
    const keep = currentIndex(list);
    list.forEach((tab, index) => {
      if (index === keep) return;
      closedTabs.unshift({ frame: e8.selectedFrame(), index, tab });
      e8.runHooks("tab-bar-tab-pre-close-functions", tab.name, false);
    });
    frameTabs.set(e8.selectedFrame(), [list[keep]]);
    update();
    if (!truthy(e8.variable("tab-bar-mode"))) e8.message("Deleted all other tabs");
  },
});

const undoCloseTab = e8.defineCommand({
  name: "tab-bar-undo-close-tab",
  doc: "Open again the tab closed last.",
  run: () => {
    while (closedTabs.length && !e8.frameList().includes(closedTabs[0].frame)) closedTabs.shift();
    const closed = closedTabs.shift();
    if (!closed) {
      e8.message("No more closed tabs to undo");
      return;
    }
    if (closed.frame !== e8.selectedFrame()) e8.selectFrame(closed.frame);
    const list = tabs();
    const index = Math.max(0, Math.min(closed.index, list.length));
    list.splice(index, 0, closed.tab);
    selectTab(index + 1);
    update();
  },
});

// --- History, as tab-bar-history-mode ---------------------------------------

const historyMode = (): boolean => truthy(e8.variable("tab-bar-history-mode"));
/** Each frame's current tab's history, as tab-bar-history-back and -forward. */
const histories = new Map<e8.Frame, { back: Saved[]; forward: Saved[] }>();
function history(frame: e8.Frame): { back: Saved[]; forward: Saved[] } {
  let h = histories.get(frame);
  if (!h) histories.set(frame, (h = { back: [], forward: [] }));
  return h;
}
/** Whether the command running changed windows that history should not keep, as tab-bar-history-omit. */
let historyOmit = false;
/** The windows before the command running, as tab-bar-history-old, and what they looked like. */
let historyOld: { saved: Saved; shape: string } | undefined;

/** What the selected frame's windows show, to tell whether a command changed them, as window-configuration-change-hook would. */
const windowShape = (): string => e8.windowList().map((w) => `${w}:${e8.windowBuffer(w)}`).join(" ");

e8.addHook("pre-command-hook", () => {
  if (!historyMode()) return;
  historyOmit = false;
  if (e8.minibufferDepth() === 0) historyOld = { saved: { wc: e8.currentWindowConfiguration(), point: pointMarker() }, shape: windowShape() };
});

e8.addHook("post-command-hook", () => {
  if (!historyMode() || historyOmit || !historyOld || e8.minibufferDepth() !== 0) return;
  if (windowShape() === historyOld.shape) return;
  const h = history(e8.selectedFrame());
  h.back = [historyOld.saved, ...h.back].slice(0, Number(e8.variable("tab-bar-history-limit") ?? 10));
  historyOld = undefined;
});

const historyBack = e8.defineCommand({
  name: "tab-bar-history-back",
  doc: "Put back the windows the current tab had before, going back in its history.",
  run: () => {
    historyOmit = true;
    const h = history(e8.selectedFrame());
    const saved = h.back.shift();
    if (!saved) {
      e8.message("No more tab back history");
      return;
    }
    if (historyOld) h.forward.unshift(historyOld.saved);
    restore(saved);
  },
});

const historyForward = e8.defineCommand({
  name: "tab-bar-history-forward",
  doc: "Undo going back in the current tab's history.",
  run: () => {
    historyOmit = true;
    const h = history(e8.selectedFrame());
    const saved = h.forward.shift();
    if (!saved) {
      e8.message("No more tab forward history");
      return;
    }
    if (historyOld) h.back.unshift(historyOld.saved);
    restore(saved);
  },
});

e8.defineMinorMode({
  name: "tab-bar-history-mode",
  global: true,
  doc: "Keep each tab's earlier window configurations: C-c <left> goes back to them and C-c <right> forward again.",
  bindings: { "C-c <left>": historyBack, "C-c <right>": historyForward },
  onChange: () => update(),
});

// --- Clicking the tab bar ---------------------------------------------------

const mouse1 = e8.defineCommand({
  name: "tab-bar-mouse-1",
  doc: "On the tab bar: select the tab clicked, close it if its close button was, or run the button clicked.",
  run: () => {
    const column = e8.lastMouseEvent()?.tabBar;
    if (column === undefined) return;
    const hit = (shownItems.get(e8.selectedFrame()) ?? []).find((s) => column >= s.from && column < s.to);
    if (!hit) return;
    if (hit.item.tab !== undefined) {
      if (hit.closeFrom !== undefined && column >= hit.closeFrom) closeTab(hit.item.tab);
      else selectTab(hit.item.tab);
    } else if (hit.item.command) e8.call(hit.item.command as e8.CommandName);
  },
});
e8.bindKey("<tab-bar> <mouse-1>", mouse1);

// --- Commands that show a buffer in another tab -----------------------------

const switchToBufferOtherTab = e8.defineCommand({
  name: "switch-to-buffer-other-tab",
  doc: "Show a buffer in a new tab, creating the buffer if there is none.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Switch to buffer in other tab: " }],
  run: (buffer) => {
    const name = buffer === "" ? (e8.windowBuffer() ?? "*scratch*") : buffer;
    e8.getBufferCreate(name);
    newTabTo();
    e8.call("switch-to-buffer", name);
  },
});

const findFileOtherTab = e8.defineCommand({
  name: "find-file-other-tab",
  doc: "Visit a file in a new tab.",
  params: [{ name: "file", kind: "file", prompt: "Find file in other tab: " }],
  run: (file) => e8.call(switchToBufferOtherTab, e8.findFileNoselect(file)),
});

const findFileReadOnlyOtherTab = e8.defineCommand({
  name: "find-file-read-only-other-tab",
  doc: "Visit a file in a new tab, read-only.",
  params: [{ name: "file", kind: "file", prompt: "Find file read-only in other tab: " }],
  run: (file) => {
    e8.call(findFileOtherTab, file);
    e8.setReadOnly(true);
  },
});

const diredOtherTab = e8.defineCommand({
  name: "dired-other-tab",
  doc: "Show a directory in Dired in a new tab.",
  params: [{ name: "directory", kind: "file", prompt: "Dired in other tab (directory): " }],
  run: (directory) => {
    newTabTo();
    e8.call("dired", directory);
  },
});

// --- The tab switcher, as tab-switcher --------------------------------------

/** The column the tab switcher's names start at, after its mark. */
let switcherColumn = 3;

e8.defineMajorMode({
  name: "tab-switcher-mode",
  modeName: "Window Configurations",
  doc:
    "The tabs other than the current one, most recent first: RET selects the tab on the line, d marks it to close and x closes " +
    "those marked, u unmarks, q goes back.",
  bindings: {
    q: "quit-window",
    RET: "tab-switcher-select",
    d: "tab-switcher-delete",
    k: "tab-switcher-delete",
    "C-d": "tab-switcher-delete-backwards",
    "C-k": "tab-switcher-delete",
    x: "tab-switcher-execute",
    SPC: "tab-switcher-next-line",
    n: "tab-switcher-next-line",
    p: "tab-switcher-prev-line",
    DEL: "tab-switcher-backup-unmark",
    "?": "describe-mode",
    u: "tab-switcher-unmark",
  },
  setup: () => {
    e8.setVariable("truncate-lines", true);
  },
});

/** The tab on the switcher's line, by its id, as tab-switcher-current-tab. */
function switcherTab(required: boolean): Tab | undefined {
  const where = e8.lineBeginningPosition() + 2 + switcherColumn;
  const id = where < e8.pointMax() ? e8.getTextProperty(where, "tab") : undefined;
  const tab = typeof id === "number" ? tabs().find((t) => t.id === id) : undefined;
  if (!tab && required) e8.userError("No window configuration on this line");
  return tab;
}

const toColumn = () => e8.moveToColumn(switcherColumn);

e8.defineCommand({
  name: "tab-switcher",
  doc: "List the tabs other than the current one, most recent first, in a tab of its own, to select or close them.",
  run: () => {
    const dir = e8.variable("default-directory");
    e8.letBind({ "tab-bar-new-tab-choice": true, "tab-bar-show": null }, () => newTabTo());
    const others = recentTabs(tabs());
    const buffer = e8.getBufferCreate(` *Tabs*<${e8.selectedFrame()}>`);
    e8.call("switch-to-buffer", buffer.name!);
    e8.setReadOnly(false);
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.call("tab-switcher-mode");
    const height = e8.windowSize()?.height ?? 0;
    e8.insert("\n".repeat(Math.max(0, Math.floor((height - others.length - 1) / 2))));
    switcherColumn = Math.max(0, Math.floor(e8.frameWidth() / 2) - 15);
    for (const tab of others) {
      e8.insert(e8.propertize(`${" ".repeat(switcherColumn)} ${tab.name}\n`, { tab: tab.id }));
    }
    e8.gotoChar(e8.pointMin());
    e8.gotoChar(e8.nextSinglePropertyChange(e8.point(), "tab") ?? e8.pointMin());
    if (others.length > 1) {
      forwardLines(1);
    }
    toColumn();
    e8.setBufferModified(false);
    e8.setReadOnly(true);
    if (typeof dir === "string") e8.setVariable("default-directory", dir);
    e8.message("Commands: d, x; RET; q to quit; ? for help.");
  },
});

function forwardLines(n: number): void {
  forwardLine(n);
  toColumn();
}

e8.defineCommand({
  name: "tab-switcher-next-line",
  doc: "Move to the next tab's line.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => forwardLines(arg),
});
e8.defineCommand({
  name: "tab-switcher-prev-line",
  doc: "Move to the previous tab's line.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => forwardLines(-arg),
});

/** Puts a mark before the line's tab: "D" or a space. */
function markLine(mark: string): void {
  e8.gotoChar(e8.lineBeginningPosition());
  toColumn();
  e8.letBind({ "inhibit-read-only": true }, () => {
    if (e8.point() < e8.pointMax() && e8.charAfter() !== "\n") e8.deleteRegion(e8.point(), e8.point() + 1);
    e8.insert(mark);
  });
}

e8.defineCommand({
  name: "tab-switcher-unmark",
  doc: "Take the mark off the line's tab, and move down, or up with a prefix argument.",
  params: [{ name: "backup", kind: "prefix" }],
  run: (backup) => {
    markLine(" ");
    forwardLines(backup === null || backup === undefined ? 1 : -1);
  },
});
e8.defineCommand({
  name: "tab-switcher-backup-unmark",
  doc: "Move up a line and take the mark off its tab.",
  run: () => {
    forwardLines(-1);
    markLine(" ");
    toColumn();
  },
});
e8.defineCommand({
  name: "tab-switcher-delete",
  doc: "Mark the line's tab to be closed by x, and move down; a prefix argument marks that many, up if negative.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => {
    const n = arg === 0 ? 1 : arg;
    for (let k = 0; k < Math.abs(n); k++) {
      markLine("D");
      forwardLine(n > 0 ? 1 : -1);
    }
    toColumn();
  },
});
e8.defineCommand({
  name: "tab-switcher-delete-backwards",
  doc: "Mark the line's tab to be closed by x, and move up.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => e8.callWithPrefix(-arg, "tab-switcher-delete"),
});
e8.defineCommand({
  name: "tab-switcher-execute",
  doc: "Close the tabs marked with d.",
  run: () => {
    e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMin());
      e8.letBind({ "inhibit-read-only": true }, () => {
        while (e8.reSearchForward(`^${" ".repeat(switcherColumn)}D`, { noerror: true }) != null) {
          e8.gotoChar(e8.point() - 1);
          const tab = switcherTab(false);
          if (tab) {
            const list = tabs();
            closedTabs.unshift({ frame: e8.selectedFrame(), index: list.indexOf(tab), tab });
            list.splice(list.indexOf(tab), 1);
            const bol = e8.lineBeginningPosition();
            e8.deleteRegion(bol, Math.min(e8.pointMax(), e8.lineEndPosition() + 1));
          } else e8.gotoChar(e8.lineEndPosition());
        }
      });
    });
    e8.gotoChar(e8.lineBeginningPosition());
    toColumn();
    update();
  },
});
e8.defineCommand({
  name: "tab-switcher-select",
  doc: "Select the line's tab, closing the switcher's own.",
  run: () => {
    const tab = switcherTab(true)!;
    e8.call("kill-buffer", e8.currentBuffer().name!);
    e8.letBind({ "inhibit-message": true }, () => {
      const saved = closedTabs.length;
      closeTab(undefined, tabs().indexOf(tab) + 1);
      closedTabs.splice(0, closedTabs.length - saved);
    });
  },
});

// --- Names and keys ---------------------------------------------------------

/** The current tab's name, for code such as a mode line, as (alist-get 'name (tab-bar--current-tab)). */
export function currentTabName(): string {
  const list = tabs();
  return list[currentIndex(list)]?.name ?? "";
}
e8.defun("tab-bar--current-tab-name", () => currentTabName());

for (const [alias, command] of [
  ["tab-new", "tab-bar-new-tab"],
  ["tab-new-to", "tab-bar-new-tab-to"],
  ["tab-duplicate", "tab-bar-duplicate-tab"],
  ["tab-close", "tab-bar-close-tab"],
  ["tab-close-other", "tab-bar-close-other-tabs"],
  ["tab-undo", "tab-bar-undo-close-tab"],
  ["tab-select", "tab-bar-select-tab"],
  ["tab-switch", "tab-bar-switch-to-tab"],
  ["tab-next", "tab-bar-switch-to-next-tab"],
  ["tab-previous", "tab-bar-switch-to-prev-tab"],
  ["tab-last", "tab-bar-switch-to-last-tab"],
  ["tab-recent", "tab-bar-switch-to-recent-tab"],
  ["tab-move", "tab-bar-move-tab"],
  ["tab-move-to", "tab-bar-move-tab-to"],
  ["tab-rename", "tab-bar-rename-tab"],
  ["tab-list", "tab-switcher"],
] as const) {
  e8.defalias(alias, command);
}

const tabPrefixMap = e8.defineKeymap("tab-prefix-map");
for (const [keys, command] of [
  ["n", duplicateTab],
  ["N", newTabToCommand],
  ["2", newTab],
  ["1", closeOtherTabs],
  ["0", closeTabCommand],
  ["u", undoCloseTab],
  ["o", nextTab],
  ["O", prevTab],
  ["m", moveTab],
  ["M", moveTabToCommand],
  ["r", renameTabCommand],
  ["RET", switchTab],
  ["b", switchToBufferOtherTab],
  ["f", findFileOtherTab],
  ["C-f", findFileOtherTab],
  ["C-r", findFileReadOnlyOtherTab],
  ["d", diredOtherTab],
] as const) {
  e8.bindKey(keys, command, "tab-prefix-map");
}
e8.bindKey("C-x t", tabPrefixMap);
e8.bindKey("C-<tab>", nextTab, "tab-bar-mode-map");
e8.bindKey("C-S-<tab>", prevTab, "tab-bar-mode-map");

void selectTabCommand;
void lastTab;
void recentTab;
