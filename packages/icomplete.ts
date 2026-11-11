// Icomplete, after Emacs's icomplete.el: as you type in the minibuffer, it
// shows what the input could complete to. icomplete-mode lists them after
// the input, {like | this}; C-. and C-, rotate them, C-j takes the first
// and C-M-i completes to it. fido-mode works like ido: completion is flex,
// RET takes the first completion or goes into a directory, DEL goes up one,
// and M-j takes the input as typed. icomplete-vertical-mode and
// fido-vertical-mode list the completions down the minibuffer instead, with
// C-n and C-p to move through them.
//
// Emacs keeps the sorted completions in completion-all-sorted-completions,
// which the rotating commands change; E8's core keeps them for the open
// prompt, and these commands change them with cacheAllSortedCompletions.
// Emacs can wait a moment before working out completions while you type;
// E8 works them out at once.

e8.defineFace({
  name: "icomplete-first-match",
  doc: "The first of the completions icomplete lists, which C-j takes.",
  attributes: { bold: true },
});
e8.defineFace({
  name: "icomplete-selected-match",
  doc: "The completion selected in a vertical list, which C-j takes.",
  attributes: { background: "selection" },
});
e8.defineFace({
  name: "completions-common-part",
  doc: "The part of a completion that matches the input.",
  attributes: { foreground: "accent-ink" },
});
e8.defineFace({
  name: "completions-annotations",
  doc: "What a completion list adds after a completion, such as a command's key.",
  attributes: { inherit: "shadow", italic: true },
});

e8.defineVariable({
  name: "icomplete-separator",
  doc: "What icomplete puts between the completions it lists in a line.",
  value: " | ",
});
e8.defineVariable({
  name: "icomplete-hide-common-prefix",
  doc: "Whether icomplete leaves out of each completion it lists the part they all share, which it shows after the input instead.",
  value: true,
});
e8.defineVariable({
  name: "icomplete-show-matches-on-no-input",
  doc: "Whether icomplete lists completions before anything is typed. fido-mode turns it on.",
  value: false,
});
e8.defineVariable({
  name: "icomplete-matches-format",
  doc: "How a vertical list that scrolls says which completion is selected, of how many: %s for each number, or nil for nothing.",
  value: "%s/%s ",
});
e8.defineVariable({
  name: "icomplete-prospects-height",
  doc: "How many lines icomplete's list may take, with the input. Vertical lists take up to 25, as max-mini-window-height allows.",
  value: 2,
});
e8.defineVariable({
  name: "icomplete-scroll",
  doc: "Whether moving through completions scrolls the list rather than rotating it. fido-vertical-mode turns it on.",
  value: false,
});
e8.defineHook(
  "icomplete-minibuffer-setup-hook",
  "Run when icomplete starts on a prompt, in the minibuffer, to set it up for this prompt.",
);

const on = (name: string): boolean => {
  const value = e8.variable(name);
  return value !== null && value !== false && value !== undefined;
};

const setLocal = (name: string, value: e8.Value): void => {
  e8.makeLocalVariable(name);
  e8.setVariable(name, value);
};

/** Text in a face, or plain. */
type FacedText = string | { text: string; face?: string | string[] | null };

/** Pieces of text as one propertized string, the cursor on its first character if `cursor`, as icomplete-exhibit puts it there. */
function faced(pieces: FacedText[], cursor: boolean): e8.PropertizedString {
  const parts = pieces.map((p) => (typeof p === "string" ? { text: p, face: null } : p));
  const strings: (string | e8.PropertizedString)[] = [];
  let first = cursor;
  for (const { text, face } of parts) {
    if (text === "") continue;
    const props: { [name: string]: e8.Value } = face ? { face } : {};
    if (first) {
      const [c, ...rest] = [...text];
      strings.push(e8.propertize(c, { ...props, cursor: true }), e8.propertize(rest.join(""), props));
      first = false;
    } else {
      strings.push(e8.propertize(text, props));
    }
  }
  return e8.concat(...strings);
}

/**
 * The overlays icomplete shows in the minibuffer, as icomplete-overlay: one
 * at the start, before the prompt, with how far through the completions
 * the selection is, and one at the end with the list.
 */
let overlays: { count: number; list: number } | undefined;

/** Shows `count` before the prompt and `list` after the input. */
function showOverlays(count: e8.PropertizedString | string, list: e8.PropertizedString): void {
  // The overlays of an outer minibuffer stay there: an inner one gets its own.
  const here = e8.bufferName();
  if (overlays === undefined || e8.overlayBuffer(overlays.count) !== here || e8.overlayBuffer(overlays.list) !== here) {
    overlays = { count: e8.makeOverlay(e8.pointMin(), e8.pointMin()), list: e8.makeOverlay(e8.pointMax(), e8.pointMax()) };
  }
  e8.moveOverlay(overlays.count, e8.pointMin(), e8.pointMin());
  e8.moveOverlay(overlays.list, e8.pointMax(), e8.pointMax());
  e8.overlayPut(overlays.count, "before-string", count);
  e8.overlayPut(overlays.list, "after-string", list);
}

/** The minibuffer's input, after its prompt, icomplete--field-string. */
const fieldString = (): string => e8.minibufferContents();

/** The input the prompt opened with, icomplete--initial-input. */
let initialInput = "";
/** When the list scrolls, the completions the selection has gone past, the nearest first. */
let scrolledPast: string[] = [];
/** When the list scrolls, the completions from the selected one on, before the input changed. */
let scrolledCompletions: string[] | undefined;

const category = (): string | null => e8.minibufferInfo()?.category ?? null;

/** Whether the prompt completes, and icomplete should work on it: icomplete-simple-completing-p. */
const simpleCompleting = (): boolean => !e8.executingKbdMacro() && e8.minibufferInfo()?.completing === true;

function ignoredFileName(name: string): boolean {
  if (name === "../") return true;
  const ignored = e8.variable("completion-ignored-extensions");
  return Array.isArray(ignored) && ignored.some((ext) => typeof ext === "string" && name.endsWith(ext));
}

/**
 * The completions in the order icomplete offers them, as
 * icomplete--sorted-completions: the kept ones, or freshly sorted with the
 * default first when nothing has been typed, and in fido-mode a file
 * name's "./" first, so RET RET visits the directory.
 */
function sortedCompletions(): { base: string; completions: string[] } | undefined {
  const field = fieldString();
  // icomplete-exhibit works them out with point at the end of the input.
  const all = e8.completionAllSortedCompletions({ atEnd: true });
  if (all === undefined || !all.fresh) return all;
  scrolledPast = [];
  const info = e8.minibufferInfo();
  let comps = all.completions;
  // icomplete-completions leaves out ../ and ignored extensions.
  if (info?.category === "file") comps = comps.filter((c) => !ignoredFileName(c));
  const def = info?.default ?? null;
  const bubble: ((c: string) => boolean)[] =
    def !== null && field === initialInput
      ? [(c) => c === def, (c) => c.startsWith(def)]
      : on("fido-mode") && def === null && info?.category === "file"
        ? [(c) => c === "./"]
        : [];
  for (const fn of bubble) {
    const i = comps.findIndex(fn);
    if (i === 0) break;
    if (i > 0) {
      comps = [comps[i], ...comps.slice(0, i), ...comps.slice(i + 1)];
      break;
    }
  }
  e8.cacheAllSortedCompletions(comps);
  return { base: all.base, completions: comps };
}

const foldCase = (): boolean => e8.minibufferInfo()?.ignoreCase ?? on("completion-ignore-case");

/** The completion with the characters the input matched in completions-common-part, as completion-lazy-hilit does. */
function hilit(comp: string, name: string): FacedText[] {
  const fold = foldCase();
  const c = fold ? comp.toLowerCase() : comp;
  const n = fold ? name.toLowerCase() : name;
  if (n === "") return [comp];
  let matched: number[] = [];
  const at = c.startsWith(n) ? 0 : c.indexOf(n);
  if (at >= 0) {
    matched = [...Array(n.length).keys()].map((i) => at + i);
  } else {
    let from = 0;
    for (const ch of n) {
      const found = c.indexOf(ch, from);
      if (found < 0) return [comp];
      matched.push(found);
      from = found + 1;
    }
  }
  const pieces: FacedText[] = [];
  let i = 0;
  while (i < comp.length) {
    const inside = matched.includes(i);
    let j = i;
    while (j < comp.length && matched.includes(j) === inside) j++;
    pieces.push(inside ? { text: comp.slice(i, j), face: "completions-common-part" } : comp.slice(i, j));
    i = j;
  }
  return pieces;
}

/** Adds a face to pieces of text, after the faces they have. */
const withFace = (pieces: FacedText[], face: string): FacedText[] =>
  pieces.map((p) =>
    typeof p === "string" ? { text: p, face } : { text: p.text, face: [...[p.face ?? []].flat(), face] }
  );

const width = (text: string): number => [...text].length;

/** The longest prefix all the names share. */
function commonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/** How many leading characters two strings share, or true if they are equal, as compare-strings sees it. */
function compareStrings(a: string, b: string): number | true {
  const fold = foldCase();
  const x = fold ? a.toLowerCase() : a;
  const y = fold ? b.toLowerCase() : b;
  if (x === y) return true;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/** What a completion list adds after a command: its key, as read-extended-command--affixation does. */
function suffix(comp: string): FacedText[] {
  if (category() !== "command") return [];
  const keys = e8.whereIs(comp);
  return keys === undefined ? [] : [{ text: ` (${keys})`, face: "completions-annotations" }];
}

/** The completions down the minibuffer, as icomplete--render-vertical. */
function renderVertical(comps: string[], name: string): FacedText[] {
  const height = Number(e8.variable("icomplete-prospects-height") ?? 25);
  const totalSpace = Math.min(height, Math.trunc(e8.frameSize().maxMiniWindowLines)) - 1;
  const scroll = on("icomplete-scroll");
  // After the input changed, keep the selection on the completion it was
  // on, if it is still there.
  if (scroll && scrolledCompletions !== undefined && scrolledPast.length === 0) {
    const i = comps.indexOf(scrolledCompletions[0]);
    if (i >= 0) {
      scrolledPast = comps.slice(0, i).reverse();
      comps = comps.slice(i);
      e8.cacheAllSortedCompletions(comps);
    } else {
      scrolledCompletions = undefined;
    }
  }
  const preds = [...scrolledPast];
  const succs = comps.slice(1);
  const above: string[] = [];
  const below: string[] = [];
  // Emacs counts the completions after the selected one, up to half the
  // lines: its list ends in its base size, which stops the count a step early.
  let spaceAbove = totalSpace - 1 - Math.min(comps.length - 1, Math.trunc(totalSpace / 2));
  for (let k = 0; k < totalSpace; k++) {
    if (preds.length > 0 && spaceAbove > 0) {
      above.unshift(preds.shift()!);
      spaceAbove--;
    } else if (succs.length > 0) {
      below.push(succs.shift()!);
    } else {
      break;
    }
  }
  const chosen = [...above, comps[0], ...below];
  const maxLen = Math.max(...chosen.map(width));
  const out: FacedText[] = [" \n"];
  chosen.slice(0, totalSpace).forEach((comp, k) => {
    let line = hilit(comp, name);
    if (k === above.length) line = withFace(line, "icomplete-selected-match");
    line.push(" ".repeat(maxLen - width(comp)), ...suffix(comp));
    out.push(...line, "\n");
  });
  return out;
}

/**
 * What icomplete shows after the input, as icomplete-completions: the
 * completions in braces with the part the input would complete to in
 * brackets before them, a single one as [Matched], or [No matches].
 * Parentheses instead of brackets say the answer must be a match.
 */
function completionsDisplay(name: string, requireMatch: boolean): FacedText[] {
  const sorted = sortedCompletions();
  const [open, close] = requireMatch ? ["(", ")"] : ["[", "]"];
  const comps = sorted?.completions ?? [];
  if (comps.length === 0) return [` ${open}No matches${close}`];
  const base = sorted!.base;
  const namePart = name.slice(base.length);
  if (on("icomplete-vertical-mode")) return renderVertical(comps, namePart);
  const scroll = on("icomplete-scroll");
  const hide = on("icomplete-hide-common-prefix");
  // Over the whole table for a file name, whose completions have a base,
  // and else over the completions themselves, as Emacs does.
  const mostTry = hide || comps.length === 1
    ? e8.completionTryCompletion(name, base.length > 0 ? undefined : comps)
    : undefined;
  const most = typeof mostTry === "object" ? mostTry.text : mostTry === true ? comps[0] : "";
  const ellipsis = "…";
  let compare = compareStrings(name, most);
  let determ: string | undefined;
  if (compare !== true && mostTry !== true && compare !== most.length) {
    determ = open +
      (compare === name.length
        ? most.slice(compare)
        : compare < 2 + width(ellipsis)
          ? most
          : ellipsis + most.slice(compare)) +
      close;
  }
  if (mostTry === true || (!scroll && comps.length === 1)) return [`${determ ?? ""} [Matched]`];
  const prompt = e8.minibufferInfo()?.prompt ?? "";
  const separator = String(e8.variable("icomplete-separator") ?? " | ");
  let prospectsLen = width(determ ?? open + close) + width(separator) + 2 + width(ellipsis) + width(prompt + name);
  const columns = e8.frameSize().columns;
  const height = Number(e8.variable("icomplete-prospects-height") ?? 2);
  const prospectsMax = (height + Math.trunc(prospectsLen / columns)) * columns;
  const prefix = hide ? commonPrefix(comps) : undefined;
  const prefixLen = prefix !== undefined && (foldCase() ? most.toLowerCase().startsWith(prefix.toLowerCase()) : most.startsWith(prefix))
    ? prefix.length
    : undefined;
  if (comps.includes(namePart)) determ = open + close;
  const prospects: FacedText[][] = [];
  let limit = false;
  for (const cur of comps) {
    const comp = prefixLen !== undefined ? cur.slice(prefixLen) : cur;
    prospectsLen += width(comp) + width(separator);
    if (prospectsLen < prospectsMax) {
      prospects.push(prefixLen !== undefined ? [comp] : hilit(comp, namePart));
    } else {
      limit = true;
      break;
    }
  }
  if (prospects.length > 0) prospects[0] = withFace(prospects[0], "icomplete-first-match");
  const out: FacedText[] = [`${determ ?? ""}{`];
  prospects.forEach((p, k) => {
    if (k > 0) out.push(separator);
    out.push(...p);
  });
  out.push(`${limit ? separator + ellipsis : ""}}`);
  return out;
}

/** Shows the completions after the input, as icomplete-exhibit does after each command. */
function exhibit(): void {
  if (!on("icomplete-mode") || !simpleCompleting()) return;
  const field = fieldString();
  // Back at the input it started with, what was shown stays, as in Emacs.
  if (!on("icomplete-show-matches-on-no-input") && field === initialInput) return;
  const info = e8.minibufferInfo()!;
  const after = completionsDisplay(field, info.requireMatch);
  let before = "";
  const format = e8.variable("icomplete-matches-format");
  if (on("icomplete-scroll") && typeof format === "string") {
    const past = scrolledPast.length;
    const kept = e8.minibufferInfo()?.kept ?? 0;
    before = format.replace("%s", String(past + 1)).replace("%s", String(past + kept));
  }
  showOverlays(before === "" ? "" : e8.propertize(before, { face: "shadow" }), faced(after, true));
}

e8.defineKeymap("icomplete-minibuffer-map");
e8.defineKeymap("icomplete-fido-mode-map");
e8.defineKeymap("icomplete-vertical-mode-minibuffer-map");

function icompleteSetup(): void {
  initialInput = fieldString();
  scrolledPast = [];
  scrolledCompletions = undefined;
  e8.composeLocalMap("icomplete-minibuffer-map");
  e8.addHook("post-command-hook", exhibit, { local: true });
  e8.runHooks("icomplete-minibuffer-setup-hook");
}

function fidoSetup(): void {
  e8.composeLocalMap("icomplete-fido-mode-map");
  setLocal("icomplete-show-matches-on-no-input", true);
  setLocal("icomplete-hide-common-prefix", false);
  setLocal("icomplete-scroll", on("icomplete-vertical-mode"));
  setLocal("completion-styles", ["flex"]);
  // Flex first in each category too, as icomplete--fido-ccd puts it.
  const defaults = e8.variable("completion-category-defaults");
  if (Array.isArray(defaults)) {
    setLocal("completion-category-defaults", defaults.map((entry) => {
      if (!Array.isArray(entry) || !Array.isArray(entry[1])) return entry;
      return [entry[0], ["flex", ...entry[1].filter((s) => s !== "flex")]];
    }));
  }
  setLocal("completion-ignore-case", true);
}

function verticalSetup(): void {
  e8.composeLocalMap("icomplete-vertical-mode-minibuffer-map");
  setLocal("icomplete-hide-common-prefix", false);
  setLocal("icomplete-prospects-height", 25);
}

// Emacs adds fido's setup to minibuffer-setup-hook after icomplete's, so
// it runs first, and icomplete's keymap goes in front of fido's.
e8.addHook("minibuffer-setup-hook", () => {
  if (!on("icomplete-mode") || !simpleCompleting()) return;
  if (on("fido-mode")) fidoSetup();
  icompleteSetup();
  exhibit();
});

// Commands.

/** Rotates the completions, or scrolls them with icomplete-scroll: forward if `step` is 1, back if -1. */
function step(forward: boolean): boolean {
  // As Emacs's completion-all-sorted-completions: the kept completions, or
  // freshly sorted ones without what icomplete's display leaves out.
  const sorted = e8.completionAllSortedCompletions();
  if (sorted === undefined) return false;
  const comps = [...sorted.completions];
  const scroll = on("icomplete-scroll");
  let stepped = false;
  if (forward) {
    if (comps.length < 2) return false;
    if (scroll) {
      scrolledPast.unshift(comps.shift()!);
      scrolledCompletions = comps;
    } else {
      comps.push(comps.shift()!);
    }
    stepped = true;
  } else if (scroll) {
    if (scrolledPast.length > 0) {
      comps.unshift(scrolledPast.shift()!);
      scrolledCompletions = comps;
      stepped = true;
    }
  } else if (comps.length >= 2) {
    comps.unshift(comps.pop()!);
    stepped = true;
  }
  e8.cacheAllSortedCompletions(comps);
  return stepped;
}

e8.defineCommand({
  name: "icomplete-forward-completions",
  doc: "Step forward through the completions icomplete shows: the second becomes the first, which C-j takes.",
  run: () => void step(true),
});
e8.defineCommand({
  name: "icomplete-backward-completions",
  doc: "Step back through the completions icomplete shows: the last becomes the first, which C-j takes.",
  run: () => void step(false),
});
e8.defineCommand({
  name: "icomplete-vertical-goto-first",
  doc: "Go to the first of the completions, in a list that scrolls (icomplete-scroll).",
  run: () => {
    if (!on("icomplete-scroll")) throw new Error("Only works with `icomplete-scroll'");
    while (step(false));
  },
});
e8.defineCommand({
  name: "icomplete-vertical-goto-last",
  doc: "Go to the last of the completions, in a list that scrolls (icomplete-scroll).",
  run: () => {
    if (!on("icomplete-scroll")) throw new Error("Only works with `icomplete-scroll'");
    while (step(true));
  },
});
e8.defineCommand({
  name: "icomplete-force-complete",
  doc: "Complete the input to the first of the completions icomplete shows.",
  run: () => e8.call("minibuffer-force-complete"),
});
e8.defineCommand({
  name: "icomplete-force-complete-and-exit",
  doc:
    "Complete the input to the first of the completions icomplete shows, and finish it.\n\n" +
    "With nothing typed, and the completions not listed, finish with the default instead.",
  run: () => {
    const info = e8.minibufferInfo();
    const field = fieldString();
    const force = field !== initialInput ||
      (info?.default == null && on("icomplete-show-matches-on-no-input")) ||
      (info?.kept ?? 0) > 0;
    e8.call(force ? "minibuffer-force-complete-and-exit" : "minibuffer-complete-and-exit");
  },
});

e8.defineCommand({
  name: "icomplete-fido-ret",
  doc: "Finish the input with the first completion, or for a directory, go into it, as ido-mode does.",
  run: () => {
    const sorted = sortedCompletions();
    const current = sorted?.completions[0];
    const field = fieldString();
    const dir = category() === "file" ? field.slice(0, field.lastIndexOf("/") + 1) : undefined;
    const probe = dir !== undefined && current !== undefined ? dir + current.replace(/\/$/, "") : undefined;
    if (probe !== undefined && current !== "./" && e8.fileDirectoryP(probe)) {
      e8.callInteractively("icomplete-force-complete");
    } else {
      e8.callInteractively("icomplete-force-complete-and-exit");
    }
  },
});
e8.defineCommand({
  name: "icomplete-fido-exit",
  doc:
    "Finish the input as it is typed, not as it would complete.\n\n" +
    "Where the answer must be a completion, complete it first, unless given a prefix argument.",
  run: () => {
    const force = e8.prefixArg() !== null;
    e8.call(!force && e8.minibufferInfo()?.requireMatch ? "minibuffer-complete-and-exit" : "exit-minibuffer");
  },
});
e8.defineCommand({
  name: "icomplete-fido-backward-updir",
  doc: "Delete the character before point, or after a directory's slash, go up to the directory above, as ido-mode does.",
  run: () => {
    const start = e8.minibufferPromptEnd();
    const point = e8.point();
    if (point > start && e8.bufferText(point - 1, point) === "/" && category() === "file") {
      if (fieldString() === "~/") {
        e8.deleteRegion(start, e8.pointMax());
        e8.insert(e8.expandFileName("~/").replace(/\/?$/, "/"));
      }
      const field = fieldString();
      const slash = field.lastIndexOf("/", e8.point() - start - 2);
      if (slash >= 0) e8.deleteRegion(start + slash + 1, e8.pointMax());
    } else {
      e8.callInteractively("delete-backward-char");
    }
  },
});
e8.defineCommand({
  name: "icomplete-fido-delete-char",
  doc: "Delete the character after point, or at the end of a file name, open Dired on its directory, as ido-mode does.",
  run: () => {
    const field = fieldString();
    if (e8.point() - e8.minibufferPromptEnd() < field.length || category() !== "file") {
      e8.callInteractively("delete-char");
      return;
    }
    e8.call("dired", field.slice(0, field.lastIndexOf("/") + 1));
    e8.call("exit-minibuffer");
  },
});
e8.defineCommand({
  name: "icomplete-fido-kill",
  doc: "Kill the rest of the line, as C-k does, if point is not at the end of the input.",
  run: () => {
    if (e8.point() - e8.minibufferPromptEnd() < fieldString().length) {
      e8.callInteractively("kill-line");
      return;
    }
    throw new Error("Killing the selected completion needs a minibuffer inside the minibuffer, which E8 does not have yet");
  },
});

for (const [keys, command] of [
  ["C-M-i", "icomplete-force-complete"],
  ["C-j", "icomplete-force-complete-and-exit"],
  ["C-.", "icomplete-forward-completions"],
  ["C-,", "icomplete-backward-completions"],
] as const) {
  e8.bindKey(keys, command, "icomplete-minibuffer-map");
}
for (const [keys, command] of [
  ["C-k", "icomplete-fido-kill"],
  ["C-d", "icomplete-fido-delete-char"],
  ["RET", "icomplete-fido-ret"],
  ["DEL", "icomplete-fido-backward-updir"],
  ["M-j", "icomplete-fido-exit"],
  ["C-s", "icomplete-forward-completions"],
  ["C-r", "icomplete-backward-completions"],
  ["<right>", "icomplete-forward-completions"],
  ["<left>", "icomplete-backward-completions"],
  ["C-.", "icomplete-forward-completions"],
  ["C-,", "icomplete-backward-completions"],
] as const) {
  e8.bindKey(keys, command, "icomplete-fido-mode-map");
}
for (const [keys, command] of [
  ["C-n", "icomplete-forward-completions"],
  ["C-p", "icomplete-backward-completions"],
  ["<down>", "icomplete-forward-completions"],
  ["<up>", "icomplete-backward-completions"],
  ["M-<", "icomplete-vertical-goto-first"],
  ["M->", "icomplete-vertical-goto-last"],
] as const) {
  e8.bindKey(keys, command, "icomplete-vertical-mode-minibuffer-map");
}

// The modes. They are global; what they do happens as each prompt opens.

const setMode = (name: e8.CommandName, enable: boolean): void => {
  if (on(name) !== enable) e8.callWithPrefix(enable ? 1 : 0, name);
};

e8.defineMinorMode({
  name: "icomplete-mode",
  global: true,
  doc:
    "Show what the minibuffer's input could complete to, as you type.\n\n" +
    "The completions follow the input in braces, the first of them in bold, with what the input " +
    "would complete to in brackets before them: [Matched] for a single match, [No matches] for none, " +
    "and parentheses rather than brackets where the answer must be a match. C-. and C-, rotate them, " +
    "C-j takes the first, and C-M-i completes the input to it.",
  onChange: (enabled) => {
    if (enabled && on("fido-mode")) {
      setMode("fido-mode", false);
      e8.setVariable("icomplete-mode", true);
    }
  },
});
e8.defineMinorMode({
  name: "fido-mode",
  global: true,
  doc:
    "Show completions as icomplete-mode does, with keys that work like ido-mode's.\n\n" +
    "Completion is flex, ignoring case, and the completions show before anything is typed. RET takes the " +
    "first, or goes into a directory, DEL after a slash goes up a directory, C-d at the end opens Dired " +
    "there, M-j finishes the input as typed, and C-s and C-r rotate the completions.",
  onChange: (enabled) => {
    if (enabled) {
      setMode("icomplete-mode", false);
      e8.setVariable("icomplete-mode", true);
    } else {
      e8.setVariable("icomplete-mode", false);
    }
  },
});
e8.defineMinorMode({
  name: "icomplete-vertical-mode",
  global: true,
  doc:
    "List completions down the minibuffer, in icomplete-mode or fido-mode, turning icomplete-mode on if neither is.\n\n" +
    "As many show as max-mini-window-height allows. C-n and C-p, or <down> and <up>, move through them.",
  onChange: (enabled) => {
    e8.removeHook("icomplete-minibuffer-setup-hook", verticalSetup);
    if (enabled) {
      if (!on("icomplete-mode")) setMode("icomplete-mode", true);
      e8.addHook("icomplete-minibuffer-setup-hook", verticalSetup);
    }
  },
});
e8.defineMinorMode({
  name: "fido-vertical-mode",
  global: true,
  doc:
    "List completions down the minibuffer in fido-mode, turning fido-mode on if it is off.\n\n" +
    "The list scrolls as C-n and C-p move through it, and says which completion is selected, of how many.",
  onChange: (enabled) => {
    setMode("icomplete-vertical-mode", false);
    if (enabled) {
      if (!on("fido-mode")) setMode("fido-mode", true);
      setMode("icomplete-vertical-mode", true);
    }
  },
});

// E8 lists completions by default, where Emacs does not.
e8.callWithPrefix(1, "icomplete-mode");
