// Showing the keys that can follow a prefix, after Emacs's which-key.el:
// with which-key-mode on, a pause after a prefix key such as C-x opens a
// window along the bottom of the frame listing in columns each key that
// can come next, with the command it runs or +prefix for another prefix.
// The window goes when the key sequence ends.

import { truthy } from "subr";

for (const [name, value, doc] of [
  ["which-key-idle-delay", 1.0, "Seconds to wait after a prefix key before showing what can follow it."],
  ["which-key-max-description-length", 27, "How long a description may be before it is cut, ending in which-key-ellipsis."],
  ["which-key-min-column-description-width", 0, "The narrowest a column's descriptions are."],
  ["which-key-add-column-padding", 0, "Spaces added before each column's keys."],
  ["which-key-unicode-correction", 3, "Columns left free at the window's right edge."],
  ["which-key-separator", " : ", "What goes between a key and its description."],
  ["which-key-ellipsis", "..", "What a cut description ends in."],
  ["which-key-prefix-prefix", "+", "What goes before the description of a key that is a prefix."],
  ["which-key-show-prefix", "echo", 'Where the prefix typed shows: "echo" in the echo area, "left" before the first column, "top" above them, or nil.'],
  ["which-key-popup-type", "side-window", 'Where the keys show: "side-window", a window along the bottom of the frame.'],
  ["which-key-side-window-location", "bottom", "Which side of the frame the window goes on: only the bottom for now."],
  ["which-key-side-window-max-height", 0.25, "The tallest the window gets: lines, or a fraction of the frame's height."],
  ["which-key-show-remaining-keys", false, "Whether the mode line says how many keys did not fit."],
  ["which-key-sort-uppercase-first", true, "Whether a capital letter sorts before its small letter."],
  ["which-key-max-display-columns", null, "The most columns shown, or nil for as many as fit."],
  ["which-key-inhibit", false, "Whether showing is turned off for now."],
] as const) {
  e8.defineVariable({ name, value: value as e8.Value, doc });
}

e8.defineFace({ name: "which-key-key-face", doc: "The keys which-key lists.", attributes: { inherit: "font-lock-constant-face" } });
e8.defineFace({ name: "which-key-separator-face", doc: "Between a key and its description.", attributes: { inherit: "font-lock-comment-face" } });
e8.defineFace({ name: "which-key-note-face", doc: "Notes, such as page numbers.", attributes: { inherit: "which-key-separator-face" } });
e8.defineFace({
  name: "which-key-command-description-face",
  doc: "A command's name in which-key's list.",
  attributes: { inherit: "font-lock-function-name-face" },
});
e8.defineFace({
  name: "which-key-group-description-face",
  doc: "The description of a key that is a prefix.",
  attributes: { inherit: "font-lock-keyword-face" },
});

/** Descriptions given to prefixes, by the prefix's keys, as which-key-add-key-based-replacements makes them. */
const prefixNames = new Map<string, string>();

/** Names what keys show, as which-key-add-key-based-replacements: pairs of keys, such as "C-c a", and a description. */
export function addKeyBasedReplacements(...pairs: string[]): void {
  for (let i = 0; i + 1 < pairs.length; i += 2) prefixNames.set(pairs[i], pairs[i + 1]);
}
e8.defun("which-key-add-key-based-replacements", (...pairs: string[]) => addKeyBasedReplacements(...pairs));

e8.defun("which-key-setup-side-window-bottom", () => {
  e8.setVariable("which-key-popup-type", "side-window");
  e8.setVariable("which-key-side-window-location", "bottom");
  e8.setVariable("which-key-show-prefix", "echo");
});

// --- Sorting, as which-key-key-order ----------------------------------------

/** As which-key--string<. */
function stringLess(a: string, b: string): boolean {
  if (truthy(e8.variable("which-key-sort-uppercase-first"))) return a < b;
  const [aUp, bUp] = [a !== a.toLowerCase(), b !== b.toLowerCase()];
  return aUp === bUp ? a < b : bUp;
}

/** Orders keys as which-key--key-description<: single characters, then special keys, function keys and modified ones. */
function keyLess(a: string, b: string): boolean {
  if (a === "" || b === "") return a === "" && b !== "";
  const special = /^(RET|SPC|TAB|DEL|LFD|ESC|NUL)/;
  const [as, bs] = [special.test(a), special.test(b)];
  if (as && bs) return a.slice(0, 3) === b.slice(0, 3) ? keyLess(a.slice(3), b.slice(3)) : stringLess(a, b);
  if (as || bs) return as;
  const [a1, b1] = [[...a].length === 1, [...b].length === 1];
  if (a1 && b1) return stringLess(a, b);
  if (a1 || b1) return a1;
  const fn = /<f([0-9]+)>/;
  const [af, bf] = [fn.exec(a), fn.exec(b)];
  if (af && bf) return Number(af[1]) < Number(bf[1]);
  if (af || bf) return af !== null;
  const modifier = /^(M|C|S|A|H|s)-/;
  const [am, bm] = [modifier.test(a), modifier.test(b)];
  if (am && bm) return a.slice(0, 2) === b.slice(0, 2) ? keyLess(a.slice(2), b.slice(2)) : stringLess(a, b);
  if (am || bm) return am;
  return stringLess(a, b);
}

// --- Laying the keys out, as which-key--list-to-pages -----------------------

interface Cell {
  key: string;
  description: string;
  face: string;
}

/** The keys after a prefix, sorted and described, as which-key--get-bindings with which-key--format-and-replace. */
function cells(prefix: string): Cell[] {
  const max = Number(e8.variable("which-key-max-description-length") ?? 27);
  const ellipsis = String(e8.variable("which-key-ellipsis") ?? "..");
  const plus = String(e8.variable("which-key-prefix-prefix") ?? "+");
  return e8
    .prefixBindings(prefix)
    .sort(([a], [b]) => (keyLess(a, b) ? -1 : keyLess(b, a) ? 1 : 0))
    .map(([key, command]) => {
      const named = prefixNames.get(`${prefix} ${key}`);
      let description = named ?? (command === undefined ? `${plus}prefix` : command);
      if ([...description].length > max) description = [...description].slice(0, max - [...ellipsis].length).join("") + ellipsis;
      // As which-key-replacement-alist's default: <left> shows as left.
      const shown = key.replace(/<([A-Za-z0-9-]+)>/g, "$1");
      return { key: shown, description, face: command === undefined ? "which-key-group-description-face" : "which-key-command-description-face" };
    });
}

/** The lines a page of cells makes, columns of `height` cells within `width`, and how many cells it took, as which-key--list-to-pages. */
function page(all: Cell[], height: number, width: number): { lines: (string | e8.PropertizedString)[]; shown: number } | undefined {
  const padding = Number(e8.variable("which-key-add-column-padding") ?? 0);
  const separator = String(e8.variable("which-key-separator") ?? " : ");
  const minDesc = Number(e8.variable("which-key-min-column-description-width") ?? 0);
  const maxColumns = e8.variable("which-key-max-display-columns");
  const columns: { width: number; rows: (string | e8.PropertizedString)[] }[] = [];
  for (let i = 0; i < all.length; i += height) {
    const column = all.slice(i, i + height);
    // As which-key--pad-column: keys right-aligned, descriptions padded.
    const keyWidth = padding + Math.max(...column.map((c) => e8.stringWidth(c.key)));
    const descWidth = Math.min(width - keyWidth - e8.stringWidth(separator), Math.max(minDesc, ...column.map((c) => e8.stringWidth(c.description))));
    columns.push({
      width: keyWidth + e8.stringWidth(separator) + descWidth,
      rows: column.map((c) =>
        e8.concat(
          e8.propertize(" ".repeat(keyWidth - e8.stringWidth(c.key)) + c.key, { face: "which-key-key-face" }),
          e8.propertize(separator, { face: "which-key-separator-face" }),
          e8.propertize(c.description, { face: c.face }),
          " ".repeat(Math.max(0, descWidth - e8.stringWidth(c.description))),
        ),
      ),
    });
  }
  if (columns.length === 0 || Math.max(...columns.map((c) => c.width)) > width) return undefined;
  // As many columns as fit, a space apart.
  let used = columns[0].width;
  let count = 1;
  while (
    count < columns.length &&
    (typeof maxColumns !== "number" || count < maxColumns) &&
    used + 1 + columns[count].width <= width
  ) {
    used += 1 + columns[count].width;
    count++;
  }
  const shownColumns = columns.slice(0, count);
  const rows = Math.min(height, all.length);
  const lines = Array.from({ length: rows }, (_, r) =>
    shownColumns.reduce<string | e8.PropertizedString>((line, c, k) => e8.concat(line, k > 0 ? " " : "", c.rows[r] ?? ""), ""),
  );
  return { lines, shown: Math.min(all.length, count * height) };
}

// --- The window -------------------------------------------------------------

const BUFFER = " *which-key*";
let popup: e8.Window | undefined;
/** The prefix the window shows the keys of. */
let shownPrefix: string | undefined;

/** The tallest the window may be, in lines with its mode line, as which-key--side-window-max-dimensions. */
function maxHeight(): number {
  const h = Number(e8.variable("which-key-side-window-max-height") ?? 0.25);
  return Number.isInteger(h) && h >= 1 ? h : Math.round(h * e8.frameHeight());
}

const popupLive = (): boolean => popup !== undefined && e8.windowList().includes(popup);

function hide(): void {
  if (popupLive()) e8.deleteWindow(popup);
  popup = undefined;
  shownPrefix = undefined;
}

/** Shows the keys after `prefix`, as which-key--create-buffer-and-show. */
function show(prefix: string): void {
  const all = cells(prefix);
  if (all.length === 0) {
    e8.message(`${prefix}-  which-key: There are no keys to show`);
    return;
  }
  const height = Math.max(1, maxHeight() - 1);
  const width = e8.frameWidth() - Number(e8.variable("which-key-unicode-correction") ?? 3);
  const shownPage = page(all, height, width);
  if (!shownPage) return;
  let lines = shownPage.lines;
  const showPrefix = e8.variable("which-key-show-prefix");
  const pages = Math.ceil(all.length / Math.max(1, shownPage.shown));
  if (showPrefix === "left") {
    // As which-key--process-page: the prefix in a column of its own.
    const label = `${prefix}`;
    const count = pages > 1 ? `1/${pages}` : "";
    const first = 2 + Math.max(e8.stringWidth(label), e8.stringWidth(count));
    lines = lines.map((line, r) => {
      const head = r === 0 ? label : r === 1 ? count : "";
      return e8.concat(e8.propertize(head.padEnd(first), { face: r === 0 ? "which-key-key-face" : "which-key-separator-face" }), line);
    });
  } else if (showPrefix === "top") {
    lines = [e8.concat(e8.propertize(`${prefix}-`, { face: "which-key-key-face" }), pages > 1 ? e8.propertize(` (1 of ${pages})`, { face: "which-key-note-face" }) : ""), ...lines];
  }
  const buffer = e8.getBufferCreate(BUFFER);
  e8.withCurrentBuffer(buffer, () => {
    e8.setReadOnly(false);
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    lines.forEach((line, k) => e8.insert(k > 0 ? e8.concat("\n", line) : line));
    e8.gotoChar(e8.pointMin());
    e8.setBufferModified(false);
    e8.setReadOnly(true);
    for (const [name, value] of [
      ["mode-line-format", ""],
      ["truncate-lines", true],
    ] as const) {
      e8.makeLocalVariable(name);
      e8.setVariable(name, value);
    }
  });
  const wanted = lines.length + 1;
  if (popupLive() && e8.windowSize(popup)?.totalHeight !== wanted) hide();
  if (!popupLive()) popup = e8.splitRootWindow("below", -wanted);
  e8.setWindowBuffer(popup, BUFFER);
  shownPrefix = prefix;
  if (showPrefix === "echo") {
    e8.message(`${prefix}-${pages > 1 ? ` (1 of ${pages})` : ""}`);
  }
}

/** What the timer does when the keys pause, as which-key--update. */
function update(): void {
  const prefix = e8.thisSingleCommandKeys();
  const waiting = prefix !== "" && e8.prefixBindings(prefix).length > 0 && e8.thisCommand() === undefined;
  if (waiting && !truthy(e8.variable("which-key-inhibit")) && maxHeight() > 1) {
    if (prefix !== shownPrefix) show(prefix);
  } else if (shownPrefix !== undefined) hide();
}

let timer: number | undefined;

e8.defineMinorMode({
  name: "which-key-mode",
  global: true,
  doc:
    "After a prefix key such as C-x and a pause of which-key-idle-delay seconds, show in a window along the bottom of " +
    "the frame each key that can follow it, with the command it runs.",
  onChange: (enabled) => {
    if (timer !== undefined) e8.cancelTimer(timer);
    timer = undefined;
    if (enabled) {
      timer = e8.runWithIdleTimer(Number(e8.variable("which-key-idle-delay") ?? 1), true, update);
    } else hide();
  },
});

e8.addHook("pre-command-hook", () => {
  if (shownPrefix !== undefined) hide();
});
