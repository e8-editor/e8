// Completing the text at point, after Emacs's minibuffer.el: C-M-i runs
// completion-at-point, which asks completion-at-point-functions for what
// could complete the text around point, as a language server or a mode
// gives it, and completion-in-region completes it in the buffer by the
// completion styles, as far as they go. When they go no further, the
// completions are listed in *Completions*, and while point stays in the
// text being completed, completion-in-region-mode lets M-<down>, M-<up>
// and M-RET choose one there as typing goes on in the buffer.

import { displayBuffer, fitWindowToBuffer, quitWindow } from "window";
import { forwardLine, getBufferWindow, withSelectedWindow } from "subr";

e8.defineHook(
  "completion-at-point-functions",
  "Functions that say what completes the text at point: each gives [start, end, completions] or nil, the first that gives one winning. " +
    "The completions are a list of strings, or a function giving one when called.",
);

e8.defineVariable({
  name: "completion-auto-help",
  doc:
    "Whether completing lists the completions when it cannot complete further: true; lazy, only when asked twice; " +
    "always, after each completion too; visible, after each completion while the list shows; nil, never.",
  value: true,
});
e8.defineVariable({ name: "completion-fail-discreetly", doc: "Whether completing that finds no match says nothing and does not ding.", value: null });
e8.defineVariable({ name: "completion-show-help", doc: "Whether *Completions* starts with lines saying how to choose a completion.", value: true });
e8.defineVariable({
  name: "completions-format",
  doc: "How *Completions* lays the completions out: horizontal, across the lines in columns; vertical, down the columns; or one-column.",
  value: "horizontal",
});
e8.defineVariable({
  name: "completions-header-format",
  doc: "The line at the top of *Completions*, %s the number of completions; nil for none.",
  value: "%s possible completions:\n",
});
e8.defineVariable({
  name: "completions-sort",
  doc: "How *Completions* orders the completions: alphabetical, nil to leave them in the order given, or a function of the list.",
  value: "alphabetical",
});
e8.defineVariable({
  name: "completion-cycle-threshold",
  doc: "When completing cycles through the completions, each try putting in the next: true, always; a number, when there are no more than that; nil, never.",
  value: null,
});
e8.defineVariable({ name: "completion-auto-wrap", doc: "Whether moving past the last completion in *Completions* goes to the first, and back.", value: true });

e8.defineVariable({
  name: "completions-group",
  doc: "Whether cycling keeps the order a table's groups give its completions, rather than sorting them by length. *Completions* groups them whenever the table has a group function.",
  value: null,
});
e8.defineVariable({
  name: "completions-group-sort",
  doc: "How *Completions* orders its groups: nil as the table gives them, alphabetical by title, or a function of the [title, ...completions] lists.",
  value: null,
});
/** completions-group-format's text as Emacs has it; its faces are put when it is used. */
const GROUP_FORMAT = "     %s  ";
e8.defineVariable({ name: "completions-group-format", doc: "The line above each group in *Completions*, %s its title.", value: GROUP_FORMAT });
e8.defineFace({ name: "completions-group-title", doc: "The title of a group in *Completions*.", attributes: { inherit: "shadow", slant: "italic" } });
e8.defineFace({ name: "completions-group-separator", doc: "The lines either side of a group's title in *Completions*.", attributes: { inherit: "shadow", strikeThrough: true } });

e8.defineFace({ name: "completions-highlight", doc: "The completion chosen in *Completions*.", attributes: { inherit: "highlight" } });

/** The text in the buffer being completed, and how to tell it is still there, as completion-in-region--data. */
interface RegionData {
  buffer: string;
  start: e8.Marker;
  end: e8.Marker;
  names: () => string[];
  /** Whether the text is still the one being completed, given where its start's marker now is. */
  predicate: (start: number) => boolean;
  props: CompletionProps;
}
let regionData: RegionData | undefined;

/** What runs once a completion is done, as :exit-function: given the text and finished, exact or sole. */
export type ExitFunction = (text: string, status: "finished" | "exact" | "sole") => void;

/**
 * What a completion function says besides its completions, as Emacs's
 * completion-extra-properties and a table's metadata: what to run once a
 * completion is done, what to show after each in *Completions*, and how to
 * order them there and for cycling.
 */
export interface CompletionProps {
  exitFunction?: ExitFunction;
  /** A completion's group's title, or with `transform` the completion as its group shows it, as group-function. */
  groupFunction?: (candidate: string, transform: boolean) => string | undefined | null;
  annotationFunction?: (candidate: string) => string | e8.PropertizedString | undefined | null;
  displaySortFunction?: (candidates: string[]) => string[];
  cycleSortFunction?: (candidates: string[]) => string[];
}

/** What *Completions* lists the completions of: the buffer, the text they replace, and the names. */
interface ListData {
  reference: string;
  start: e8.Marker;
  end: e8.Marker;
  names: () => string[];
  props: CompletionProps;
}
let listData: ListData | undefined;

/** The window *Completions* was last shown in, which a second try scrolls, as minibuffer-scroll-window. */
let scrollWindow: e8.Window | undefined;

const COMPLETIONS = "*Completions*";
const ignoreCase = () => truthyValue(e8.variable("completion-ignore-case"));

/** A completion style a package added, if `style` is one. */
function scriptStyle(style: string): CompletionStyle | undefined {
  return scriptStyles.get(style);
}

/**
 * What completing BEFORE and AFTER, the text either side of point, gives,
 * as completion-try-completion: the first style's that finds anything. A
 * package's style completes to its match when there is one only, and
 * leaves the text as it is for several, as orderless-try-completion does.
 */
function tryCompletion(before: string, after: string, names: string[]): null | true | { text: string; point: number } {
  const fold = ignoreCase();
  for (const style of e8.completionStyles()) {
    const own = scriptStyle(style);
    if (own) {
      const found = own.all({ base: "", before, after, suffix: "", names }, fold)?.completions ?? [];
      if (found.length === 0) continue;
      if (found.length > 1) return { text: before + after, point: before.length };
      return found[0] === before + after ? true : { text: found[0], point: found[0].length };
    }
    const tried = e8.completionTryInStyle(style, before, after, names, fold);
    if (tried !== undefined && tried !== null) return tried;
  }
  return null;
}

/** The completions of BEFORE and AFTER in the first style that finds any, as completion-all-completions. */
function allCompletions(before: string, after: string, names: string[]): string[] {
  const fold = ignoreCase();
  for (const style of e8.completionStyles()) {
    const own = scriptStyle(style);
    const found = own ? (own.all({ base: "", before, after, suffix: "", names }, fold)?.completions ?? []) : (e8.completionAllInStyle(style, before, after, names, fold) ?? []);
    if (found.length > 0) return found;
  }
  return [];
}

/** Whether TEXT is one of the names, as test-completion. */
function isCompletion(text: string, names: string[]): boolean {
  if (!ignoreCase()) return names.includes(text);
  const lower = text.toLowerCase();
  return names.some((n) => n.toLowerCase() === lower);
}

/**
 * Puts NEWTEXT in place of the text from BEG to END, as completion--replace:
 * what they already share at either end stays, with its markers and
 * properties, and point goes after the new text.
 */
function completionReplace(beg: number, end: number, newtext: string): void {
  const old = [...e8.bufferText(beg, end)];
  let chars = [...newtext];
  let prefix = 0;
  while (prefix < chars.length && prefix < old.length && old[prefix] === chars[prefix]) prefix++;
  beg += prefix;
  chars = chars.slice(prefix);
  const rest = old.slice(prefix);
  let suffix = 0;
  while (suffix < chars.length && suffix < rest.length && rest[rest.length - 1 - suffix] === chars[chars.length - 1 - suffix]) suffix++;
  end -= suffix;
  chars = chars.slice(0, chars.length - suffix);
  e8.gotoChar(beg);
  const length = end - beg;
  e8.insertAndInherit(chars.join(""));
  e8.deleteRegion(e8.point(), e8.point() + length);
  e8.gotoChar(e8.point() + suffix);
}

/** Whether TEXT is the only name that starts with it, as (eq (try-completion TEXT names) t). */
function plainTryCompletion(text: string, names: string[]): boolean {
  const fold = ignoreCase();
  const norm = (n: string) => (fold ? n.toLowerCase() : n);
  const matches = [...new Set(names.filter((n) => norm(n).startsWith(norm(text))))];
  return matches.length === 1 && matches[0] === text;
}

/**
 * A completion is done, as completion--done: the exit function is told,
 * and MESSAGE shown unless it said something itself. "unknown" is exact
 * if the text completes further, else finished.
 */
function completionDone(text: string, status: "finished" | "exact" | "sole" | "unknown", names: string[], exit: ExitFunction | undefined, message?: string): void {
  const before = exit ? e8.currentMessage() : undefined;
  if (exit) {
    const finished = status !== "unknown" ? status : plainTryCompletion(text, names) ? "finished" : "exact";
    exit(text, finished);
  }
  if (message !== undefined && (!exit || e8.currentMessage() === before)) e8.message(message);
}

/** Takes *Completions* away if a window shows it, as minibuffer-hide-completions buries it there. */
export function minibufferHideCompletions(): void {
  const window = getBufferWindow(COMPLETIONS);
  if (window) withSelectedWindow(window, () => e8.call("bury-buffer"));
}

/** The first key completion-in-region-mode binds to COMMAND. */
function modeKey(command: string): string | undefined {
  return e8.keymapBindings("completion-in-region-mode-map").find(([, c]) => c === command)?.[0];
}

/** Clears the echo area without logging, as (message nil). */
function clearMessage(): void {
  e8.message("", { log: false });
}

/**
 * Lists the completions of the text from START to END in *Completions*, as
 * minibuffer-completion-help: below the window, fitted to them, for
 * M-<down>, M-<up> and M-RET, or RET and a click there, to choose from.
 */
function completionHelp(start: number, end: number, names: () => string[], props: CompletionProps = {}): void {
  e8.message("Making completion list...");
  const text = e8.bufferText(start, end);
  const at = Math.min(Math.max(e8.point() - start, 0), text.length);
  const all = names();
  let completions = allCompletions(text.slice(0, at), text.slice(at), all);
  clearMessage();
  if (completions.length === 0 || (completions.length === 1 && completions[0] === text)) {
    minibufferHideCompletions();
    if (completions.length > 0) e8.message("Sole completion");
    else if (!truthyValue(e8.variable("completion-fail-discreetly"))) {
      e8.ding();
      e8.message("No match");
    }
    return;
  }
  const sort = e8.variable("completions-sort");
  // The table's own order first, as eglot's by the server's sortText;
  // by history only where it is specific to the completions, which in a buffer it never is.
  if (props.displaySortFunction) completions = props.displaySortFunction([...completions]);
  else if (sort === "alphabetical" || sort === "historical") completions = [...completions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  else if (typeof sort === "function" || (typeof sort === "string" && sort !== "")) completions = e8.funcall(sort as string, completions) as string[];
  const reference = e8.bufferName()!;
  // Its keys as completion-in-region-mode binds them, and a click too where there is a mouse.
  const key = (command: string) => modeKey(command) ?? `M-x ${command}`;
  const help = truthyValue(e8.variable("completion-show-help"))
    ? `${e8.displayGraphicP() ? "Click or type" : "Type"} ${key("minibuffer-choose-completion")} on a completion to select it.\n` +
      `Type ${key("minibuffer-next-completion")} or ${key("minibuffer-previous-completion")} to move point between completions.\n\n`
    : undefined;
  if (listData) {
    e8.deleteMarker(listData.start);
    e8.deleteMarker(listData.end);
  }
  // The completion replaces the text from its start to its end, as
  // field-end has it with no boundaries, and what is typed at its end
  // after the list shows, as the insert-choice function takes it in.
  listData = { reference, start: e8.makeMarker(start), end: e8.makeMarker(end, { advances: true }), names, props };
  // In their groups, as minibuffer--group-by, the groups in the order completions-group-sort says.
  const group = props.groupFunction;
  if (group) completions = groupBy(completions, group);
  // Annotated in the buffer being completed, as Emacs calls the annotation
  // function with-current-buffer the main buffer.
  const annotate = props.annotationFunction;
  const entries: Entry[] = annotate
    ? completions.map((c): Entry => {
        const ann = annotate(c);
        return ann === undefined || ann === null || ann === "" ? c : [c, ann];
      })
    : completions;
  const buffer = e8.getBufferCreate(COMPLETIONS);
  // As with-current-buffer-window: shown first, so the list is laid out
  // for its window's width, then filled, then fitted to what it holds.
  const window = e8.letBind({ "display-buffer-mark-dedicated": "soft" }, () =>
    displayBuffer(buffer, [
      ["display-buffer-reuse-window", "display-buffer-below-selected"],
      ["window-height", "fit-window-to-buffer"],
    ]),
  );
  const width = window ? e8.windowBodyWidth(window) - 1 : 79;
  e8.withCurrentBuffer(buffer, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      if (e8.variable("major-mode") !== "completion-list-mode") e8.call("completion-list-mode");
      e8.widen();
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      const header = e8.variable("completions-header-format");
      if (typeof header === "string") e8.insert(e8.propertize(header.replace("%s", String(completions.length)), { face: "shadow" }));
      insertStrings(entries, width, group);
      if (help !== undefined) {
        e8.gotoChar(e8.pointMin());
        e8.insert(help);
      }
      e8.gotoChar(e8.pointMin());
      e8.setBufferModified(false);
    });
  });
  if (window) {
    e8.setWindowPoint(window, 0);
    e8.setWindowStart(window, 0);
    fitWindowToBuffer(window);
    scrollWindow = window;
  }
  highlightChosen();
}

/**
 * Inserts the completions as completion--insert-strings does, in columns
 * as completions-format says, each with mouse-face, so a click or RET on
 * it chooses it, and completion--string, which names it.
 */
/** COMPLETIONS in the groups GROUP puts them in, each group's in their order, as minibuffer--group-by. */
function groupBy(completions: string[], group: NonNullable<CompletionProps["groupFunction"]>): string[] {
  const groups: [string | null | undefined, string[]][] = [];
  for (const c of completions) {
    const key = group(c, false);
    const found = groups.find((g) => g[0] === key);
    if (found) found[1].push(c);
    else groups.push([key, [c]]);
  }
  const order = e8.variable("completions-group-sort");
  let sorted = groups;
  if (order === "alphabetical") sorted = [...groups].sort((a, b) => (String(a[0] ?? "") < String(b[0] ?? "") ? -1 : String(a[0] ?? "") > String(b[0] ?? "") ? 1 : 0));
  else if (typeof order === "function" || (typeof order === "string" && order !== ""))
    sorted = e8.funcall(order as string, groups.map(([title, cs]) => [title ?? null, ...cs])).map((g: e8.Value[]) => [g[0] as string, g.slice(1) as string[]]);
  return sorted.flatMap((g) => g[1]);
}

/** The line above a group in *Completions*, as completions-group-format formats it, with Emacs's faces on its own format. */
function groupLine(title: string): string | e8.PropertizedString {
  const format = e8.variable("completions-group-format");
  if (typeof format !== "string") return title;
  if (format !== GROUP_FORMAT) return format.replace("%s", title);
  return e8.concat(
    e8.propertize("    ", { face: "completions-group-separator" }),
    e8.propertize(` ${title} `, { face: "completions-group-title" }),
    e8.propertize(" ", { face: "completions-group-separator", display: ["space", ":align-to", "right"] }),
  );
}

/** A completion as *Completions* lists it: alone, or with its annotation. */
type Entry = string | [string, string | e8.PropertizedString];

const entryText = (e: Entry): string => (typeof e === "string" ? e : e[0]);
const plain = (s: string | e8.PropertizedString): string => (typeof s === "string" ? s : s.string);
const entryWidth = (e: Entry): number => (typeof e === "string" ? e8.stringWidth(e) : e8.stringWidth(e[0]) + e8.stringWidth(plain(e[1])));

function insertStrings(strings: Entry[], wwidth: number, group?: CompletionProps["groupFunction"]): void {
  if (strings.length === 0) return;
  const length = Math.max(...strings.map(entryWidth));
  const columns = Math.min(Math.max(1, Math.floor(wwidth / (2 + length))), Math.max(1, Math.floor(strings.length / 2)));
  const colwidth = Math.floor(wwidth / columns);
  // As completion--insert: the completion with mouse-face, so a click or
  // RET chooses it, then its annotation, in completions-annotations unless
  // it has a face of its own.
  const one = (e: Entry) => {
    const s = entryText(e);
    // As its group shows it, as the group function transforms it, still naming the completion.
    const shown = group ? (group(s, true) ?? s) : s;
    e8.insert(e8.propertize(shown, { "mouse-face": "highlight", "completion--string": s }));
    if (typeof e === "string") return;
    const from = e8.point();
    e8.insert(e[1]);
    e8.putTextProperty(from, e8.point(), "completion--string", s);
    const faced = typeof e[1] !== "string" && e[1].properties.some(([, , props]) => props.face !== undefined);
    if (!faced) e8.putTextProperty(from, e8.point(), "face", "completions-annotations");
  };
  const format = e8.variable("completions-format");
  const same = (a: Entry, b: Entry) => entryText(a) === entryText(b) && (typeof a === "string" ? a : plain(a[1])) === (typeof b === "string" ? b : plain(b[1]));
  const unique = strings.filter((s, i) => i === 0 || !same(s, strings[i - 1]));
  const titleOf = (e: Entry) => (group ? group(entryText(e), false) : undefined);
  if (format === "one-column") {
    let lastTitle: string | null | undefined;
    unique.forEach((s, i) => {
      if (i > 0) e8.insert("\n");
      const title = titleOf(s);
      if (group && title !== lastTitle) {
        lastTitle = title;
        if (title) {
          e8.insert(groupLine(title));
          e8.insert("\n");
        }
      }
      one(s);
    });
    return;
  }
  if (format === "vertical") {
    // As completion--insert-vertical: each group down the columns, a line
    // more than its completions divide into, each column padded out to its place.
    let rest = strings;
    while (rest.length > 0) {
      let chunk = rest;
      if (group) {
        const title = titleOf(rest[0]);
        const n = rest.findIndex((e) => titleOf(e) !== title);
        chunk = n < 0 ? rest : rest.slice(0, n);
        if (title) {
          e8.gotoChar(e8.pointMax());
          e8.insert(groupLine(title));
          e8.insert("\n");
        }
      }
      rest = rest.slice(chunk.length);
      const rows = Math.floor(chunk.length / columns);
      let column = 0;
      let row = 0;
      let last: Entry | undefined;
      for (const s of chunk) {
        if (last !== undefined && same(s, last)) continue;
        last = s;
        if (row > rows) {
          forwardLine(-1 - rows);
          row = 0;
          column += colwidth;
        }
        if (column > 0) {
          e8.gotoChar(e8.lineEnd(e8.lineOf(e8.point())));
          while (e8.currentColumn() > column) {
            if (e8.point() === e8.pointMax()) e8.insert("\n");
            else {
              forwardLine(1);
              e8.gotoChar(e8.lineEnd(e8.lineOf(e8.point())));
            }
          }
          e8.insert(" ");
          e8.insert(e8.propertize("\t", { display: ["space", ":align-to", column] }));
        }
        one(s);
        if (column > 0) forwardLine(1);
        else e8.insert("\n");
        row++;
      }
    }
    return;
  }
  // Horizontal, as completion--insert-horizontal: across, then down.
  let column = 0;
  let first = true;
  let lastTitle: string | null | undefined;
  for (const s of unique) {
    if (group) {
      const title = titleOf(s);
      if (title !== lastTitle) {
        lastTitle = title;
        if (title) {
          e8.insert(first ? "" : "\n");
          e8.insert(groupLine(title));
          e8.insert("\n");
          column = 0;
          first = true;
        }
      }
    }
    if (!first) {
      if (wwidth < column + Math.max(colwidth, entryWidth(s))) {
        e8.insert("\n");
        column = 0;
      } else {
        // The space stays plain, so a column already past is still marked.
        e8.insert(" ");
        e8.insert(e8.propertize("\t", { display: ["space", ":align-to", column] }));
      }
    }
    first = false;
    one(s);
    column += colwidth * Math.ceil(length / colwidth);
  }
}

/** Marks the completion point is on in *Completions*, as cursor-face highlighting shows it there. */
let chosenOverlay: number | undefined;
function highlightChosen(): void {
  const buffer = e8.getBuffer(COMPLETIONS);
  if (!buffer || !e8.bufferLiveP(buffer)) return;
  const window = getBufferWindow(COMPLETIONS);
  e8.withCurrentBuffer(buffer, () => {
    const p = window ? e8.windowPoint(window) : e8.point();
    // The completion itself, which has mouse-face, not its annotation, as cursor-face is put.
    const on = (q: number) => e8.getTextProperty(q, "mouse-face") !== undefined;
    if (!on(p)) {
      if (chosenOverlay !== undefined) e8.moveOverlay(chosenOverlay, 0, 0);
      return;
    }
    const start = p > e8.pointMin() && on(p - 1) ? (e8.previousSinglePropertyChange(p, "mouse-face") ?? e8.pointMin()) : p;
    const end = e8.nextSinglePropertyChange(p, "mouse-face") ?? e8.pointMax();
    if (chosenOverlay === undefined || e8.overlayBuffer(chosenOverlay) !== e8.bufferName()) {
      chosenOverlay = e8.makeOverlay(start, end);
      e8.overlayPut(chosenOverlay, "face", "completions-highlight");
    } else e8.moveOverlay(chosenOverlay, start, end);
  });
}

/**
 * Completes the text from BEG to END as completion--do-completion does:
 * as far as the styles go, saying why it went no further, and listing the
 * completions when completion-auto-help asks. Gives Emacs's bits: 4 if the
 * text changed, 2 if there were completions, 1 if it is now an exact match.
 */
function doCompletion(beg: number, end: number, names: string[], listNames: () => string[], props: CompletionProps = {}): number {
  const exit = props.exitFunction;
  const string = e8.bufferText(beg, end);
  const at = Math.min(Math.max(e8.point() - beg, 0), string.length);
  const comp = tryCompletion(string.slice(0, at), string.slice(at), names);
  if (comp === null) {
    minibufferHideCompletions();
    if (!truthyValue(e8.variable("completion-fail-discreetly"))) {
      e8.ding();
      e8.message("No match");
    }
    return 0;
  }
  if (comp === true) {
    minibufferHideCompletions();
    e8.gotoChar(end);
    completionDone(string, "finished", names, exit, "Sole completion");
    return 1;
  }
  const completion = comp.text;
  let completed = completion.toLowerCase() !== string.toLowerCase();
  const unchanged = completion === string;
  if (unchanged) e8.gotoChar(end);
  else {
    completionReplace(beg, end, completion);
    end = beg + [...completion].length;
  }
  e8.gotoChar(beg + comp.point);
  if (!unchanged && !completed) return doCompletion(beg, end, names, listNames, props);
  let exact = isCompletion(completion, names);
  const autoHelp = e8.variable("completion-auto-help");
  const again = e8.thisCommand() === e8.lastCommand();
  // Cycling, as completion-cycle-threshold allows: the sorted completions,
  // if there are no more than it says, put in one at a time.
  const threshold = e8.variable("completion-cycle-threshold");
  const comps = !isNil(threshold) && (!completed || comp.point > 0) ? allSortedCompletions(beg, end, names, props) : undefined;
  flushSortedCompletions();
  if (comps && comps.length > 1 && (threshold === true || (typeof threshold === "number" && comps.length <= threshold))) {
    completed = true;
    exact = true;
    cacheSortedCompletions(beg, end, comps);
    forceComplete(beg, end, names, props);
  } else if (completed) {
    const listing = autoHelp === "always" || (autoHelp === "visible" && getBufferWindow(COMPLETIONS) !== undefined);
    if (listing) completionHelp(beg, end, listNames, props);
    else {
      minibufferHideCompletions();
      // Point short of the text's end is a sign completing is not done.
      if (exact) completionDone(completion, comp.point < [...completion].length ? "exact" : "unknown", names, exit);
    }
  } else if (!exact) {
    if (autoHelp === "lazy" ? again : truthyValue(autoHelp)) completionHelp(beg, end, listNames, props);
    else e8.message("Next char not unique");
  } else {
    if (again && truthyValue(autoHelp)) completionHelp(beg, end, listNames, props);
    completionDone(completion, "exact", names, exit, "Complete, but not unique");
  }
  return (completed ? 4 : 0) | 2 | (exact ? 1 : 0);
}

/**
 * Completes the text from START to END in the buffer, as Emacs's
 * completion-in-region, from COLLECTION, a list of strings or a function
 * giving one: as far as the completion styles go, then listing the
 * completions in *Completions*. With PREDICATE, which says whether the text
 * is still the one being completed, completion-in-region-mode keeps the
 * list while it is, for M-<down>, M-<up> and M-RET to choose from.
 */
export function completionInRegion(
  start: number,
  end: number,
  collection: string[] | (() => string[]),
  predicate?: (start: number) => boolean,
  properties?: CompletionProps | ExitFunction,
): boolean {
  const props: CompletionProps = typeof properties === "function" ? { exitFunction: properties } : (properties ?? {});
  let cached: string[] | undefined;
  const names = () => (cached ??= typeof collection === "function" ? collection().map(String) : collection);
  if (predicate) {
    clearRegionData();
    regionData = { buffer: e8.bufferName()!, start: e8.makeMarker(start), end: e8.makeMarker(end, { advances: true }), names, predicate, props };
    if (!truthyValue(e8.variable("completion-in-region-mode"))) e8.callWithPrefix(1, "completion-in-region-mode");
  }
  e8.setThisCommand("completion-at-point");
  if (e8.lastCommand() !== "completion-at-point") {
    flushSortedCompletions();
    scrollWindow = undefined;
  }
  if (scrollWindow !== undefined && e8.windowLiveP(scrollWindow) && e8.windowBuffer(scrollWindow) === COMPLETIONS) {
    // Asked again with the list showing: scroll it, back to its top once its end shows.
    const window = scrollWindow;
    if (e8.posVisibleInWindowP(e8.withCurrentBuffer(COMPLETIONS, () => e8.pointMax()), window)) e8.setWindowStart(window, 0);
    else withSelectedWindow(window, () => e8.call("scroll-up"));
    return false;
  }
  // Cycling on: the next completion.
  if (cycling && sortedCompletions) {
    forceComplete(start, end, names(), props);
    return true;
  }
  const found = doCompletion(start, end, names(), names, props);
  if (!(scrollWindow !== undefined && e8.windowLiveP(scrollWindow) && e8.windowBuffer(scrollWindow) === COMPLETIONS)) turnOffRegionMode();
  return found !== 0;
}

// Cycling, as minibuffer.el's completion-all-sorted-completions and
// minibuffer-force-complete.

/** The completions cycled through, in the order they come, and the text they complete. */
let sortedCompletions: { list: string[]; buffer: string; start: e8.Marker; end: e8.Marker } | undefined;
/** Whether completing cycles, as completion-cycling: the next try puts in the next completion. */
let cycling = false;

const isNil = (v: e8.Value | undefined) => v === undefined || v === null || v === false;

/** Forgets the completions cycled through, as completion--flush-all-sorted-completions. */
function flushSortedCompletions(): void {
  cycling = false;
  if (cycleNext) {
    e8.deleteMarker(cycleNext.start);
    cycleNext = undefined;
  }
  const sorted = sortedCompletions;
  if (!sorted) return;
  sortedCompletions = undefined;
  if (e8.getBuffer(sorted.buffer)) e8.withCurrentBuffer(sorted.buffer, () => e8.removeHook("after-change-functions", flushOnChange, { local: true }));
  e8.deleteMarker(sorted.start);
  e8.deleteMarker(sorted.end);
}

/** A change to the text being completed, not one before or after it, forgets them. */
function flushOnChange(start: number, end: number): void {
  const sorted = sortedCompletions;
  if (sorted && (start > e8.markerPosition(sorted.end)! || end < e8.markerPosition(sorted.start)!)) return;
  flushSortedCompletions();
}

function cacheSortedCompletions(start: number, end: number, list: string[]): void {
  const keep = cycling;
  const next = cycleNext;
  cycleNext = undefined;
  flushSortedCompletions();
  cycling = keep;
  cycleNext = next;
  e8.addHook("after-change-functions", flushOnChange, { local: true });
  sortedCompletions = { list, buffer: e8.bufferName()!, start: e8.makeMarker(start), end: e8.makeMarker(end) };
}

/**
 * The completions of the text from START to END, sorted for cycling, as
 * completion-all-sorted-completions: by the table's cycle sort function,
 * else by length and then alphabetically.
 */
function allSortedCompletions(start: number, end: number, names: string[], props: CompletionProps): string[] {
  if (sortedCompletions) return sortedCompletions.list;
  const text = e8.bufferText(start, end);
  const at = Math.min(Math.max(e8.point() - start, 0), text.length);
  let all = [...new Set(allCompletions(text.slice(0, at), text.slice(at), names))];
  if (all.length === 0) return all;
  // A table's cycle sort; else with completions-group and groups, the table's
  // order; else by length and then alphabetically.
  if (props.cycleSortFunction) all = props.cycleSortFunction(all);
  else if (!(truthyValue(e8.variable("completions-group")) && props.groupFunction))
    all = all.sort((a, b) => [...a].length - [...b].length || (a < b ? -1 : a > b ? 1 : 0));
  cacheSortedCompletions(start, end, all);
  return all;
}

/** The arguments the next cycling step completes with, its start a marker, as Emacs's closure keeps one. */
let cycleNext: { start: e8.Marker; names: string[]; props: CompletionProps } | undefined;

/**
 * Puts in the first of the sorted completions, as minibuffer-force-complete,
 * and unless DONT-CYCLE, sets the rest up for the next try to put in.
 */
function forceComplete(start: number, end: number, names: string[], props: CompletionProps, dontCycle = false): void {
  scrollWindow = undefined;
  const startMarker = e8.makeMarker(start);
  const all = allSortedCompletions(start, end, names, props);
  const exit = props.exitFunction;
  try {
    if (all.length === 0) {
      e8.message(sortedCompletions ? "No more completions" : "No completions");
    } else if (all.length === 1) {
      const done = all[0] === e8.bufferText(start, end);
      if (!done) completionReplace(start, end, all[0]);
      completionDone(e8.bufferText(e8.markerPosition(startMarker)!, e8.point()), "finished", names, exit, done ? "Sole completion" : undefined);
    } else {
      completionReplace(start, end, all[0]);
      const newEnd = start + [...all[0]].length;
      completionDone(e8.bufferText(e8.markerPosition(startMarker)!, e8.point()), "sole", names, exit);
      e8.setThisCommand("completion-at-point");
      if (!dontCycle) {
        const from = e8.markerPosition(startMarker)!;
        cacheSortedCompletions(from, from + (newEnd - start), [...all.slice(1), all[0]]);
        cycling = true;
        if (cycleNext) e8.deleteMarker(cycleNext.start);
        cycleNext = { start: e8.makeMarker(from), names, props };
        // The last key of those that started it goes on cycling, whatever
        // it is bound to, as (vector last-command-event); completion-at-point
        // itself cycles too, as the map's remap of it does.
        const keys = e8.thisCommandKeys().trim().split(/\s+/);
        const last = keys[keys.length - 1];
        if (last) e8.setTransientMap({ [last]: cycleCommand });
      }
    }
  } finally {
    e8.deleteMarker(startMarker);
  }
}

const cycleCommand = e8.defineCommand({
  name: "completion--cycle",
  doc: "Put in the next of the completions being cycled through.",
  run: () => {
    const next = cycleNext;
    // Cycling stopped, by a change to the text, since the key was armed:
    // the key does what completion-at-point does, as its own binding would.
    if (!next || !cycling) {
      e8.call("completion-at-point");
      return;
    }
    completionInRegion(e8.markerPosition(next.start)!, e8.point(), next.names, undefined, next.props);
  },
});

/** Whether completion-at-point should take the next completion being cycled through, as the cycling map's remap of it does. */
const cyclingOn = () => cycling && sortedCompletions !== undefined && cycleNext !== undefined && e8.lastCommand() === "completion-at-point";

function clearRegionData(): void {
  if (!regionData) return;
  e8.deleteMarker(regionData.start);
  e8.deleteMarker(regionData.end);
  regionData = undefined;
}

function turnOffRegionMode(): void {
  if (truthyValue(e8.variable("completion-in-region-mode"))) e8.callWithPrefix(-1, "completion-in-region-mode");
  else clearRegionData();
}

/**
 * After each command while completion-in-region-mode is on, as
 * completion-in-region--postch: the mode goes off, and the list with it,
 * once point leaves the text being completed or it is no longer that text.
 */
function regionPostCommand(): void {
  const data = regionData;
  const keep =
    data !== undefined &&
    e8.bufferName() === data.buffer &&
    e8.point() >= e8.markerPosition(data.start)! &&
    e8.point() <= e8.saveExcursion(() => {
      e8.gotoChar(e8.markerPosition(data.end)!);
      return e8.lineEnd(e8.lineOf(e8.point()));
    }) &&
    data.predicate(e8.markerPosition(data.start)!);
  if (!keep) turnOffRegionMode();
}

e8.defineMinorMode({
  name: "completion-in-region-mode",
  global: true,
  doc:
    "On while the completions of the text at point are listed in *Completions*: M-<down> and M-<up> move among them, " +
    "M-RET puts the one moved to in place of the text, TAB completes again and M-? lists them again. " +
    "It goes off when point leaves the text.",
  bindings: {
    "M-?": "completion-help-at-point",
    TAB: "completion-at-point",
    "M-<up>": "minibuffer-previous-completion",
    "M-<down>": "minibuffer-next-completion",
    "M-RET": "minibuffer-choose-completion",
  },
  onChange: (enabled) => {
    e8.removeHook("post-command-hook", regionPostCommand);
    if (enabled) e8.addHook("post-command-hook", regionPostCommand);
    else {
      clearRegionData();
      if (e8.windowBuffer(e8.selectedWindow()) !== COMPLETIONS) minibufferHideCompletions();
    }
  },
});

// C-g turns completion-in-region-mode off, as Emacs's keyboard-quit does.
e8.adviceAdd("keyboard-quit", "before", () => {
  if (truthyValue(e8.variable("completion-in-region-mode"))) e8.callWithPrefix(-1, "completion-in-region-mode");
});

/** What a function of completion-at-point-functions says: the text, its completions, and the plist after them. */
interface CapfData {
  start: number;
  end: number;
  names: string[] | (() => string[]);
  props: CompletionProps;
}

/**
 * The first function of completion-at-point-functions to say what completes
 * at point, and what it says: [start, end, completions], and after them,
 * as Emacs's plist, ":exit-function", ":annotation-function", ":group-function", and, where
 * Emacs's table gives them as its metadata, ":display-sort-function" and
 * ":cycle-sort-function", each with its function.
 */
function completionAtPointData(found = e8.runHookWithArgsUntilSuccess("completion-at-point-functions")): CapfData | undefined {
  if (!Array.isArray(found) || found.length < 3) return undefined;
  const [start, end, collection, ...plist] = found as [number, number, e8.Value, ...e8.Value[]];
  const names = typeof collection === "function" ? (collection as unknown as () => string[]) : Array.isArray(collection) ? collection.map(String) : [];
  const get = <T>(key: string): T | undefined => {
    const at = plist.indexOf(key);
    return at >= 0 && typeof plist[at + 1] === "function" ? (plist[at + 1] as unknown as T) : undefined;
  };
  const props: CompletionProps = {
    exitFunction: get(":exit-function"),
    annotationFunction: get(":annotation-function"),
    displaySortFunction: get(":display-sort-function"),
    cycleSortFunction: get(":cycle-sort-function"),
    groupFunction: get(":group-function"),
  };
  return { start, end, names, props };
}

/** Whether the functions still say the text being completed starts at START, as completion-at-point's predicate. */
const sameStart = (start: number) => completionAtPointData()?.start === start;

e8.defineCommand({
  name: "completion-at-point",
  doc:
    "Complete the text at point, from what completion-at-point-functions give, as far as the completion styles go; " +
    "when they go no further, list the completions in *Completions*, for M-<down>, M-<up> and M-RET to choose from.",
  run: () => {
    if (cyclingOn()) {
      e8.call("completion--cycle");
      return;
    }
    const found = e8.runHookWithArgsUntilSuccess("completion-at-point-functions");
    // A function that completes itself, as Emacs's capfs may give.
    if (typeof found === "function") {
      e8.funcall(found);
      return;
    }
    const data = completionAtPointData(found);
    if (!data) return;
    completionInRegion(data.start, data.end, data.names, sameStart, data.props);
  },
});

e8.defineCommand({
  name: "completion-help-at-point",
  doc: "List the completions of the text at point in *Completions*, as completion-at-point would when it can complete no further.",
  run: () => {
    const data = completionAtPointData();
    if (!data) {
      e8.message("Nothing to complete at point");
      return;
    }
    const { start, end, names: collection, props } = data;
    let cached: string[] | undefined;
    const names = () => (cached ??= typeof collection === "function" ? collection().map(String) : collection);
    clearRegionData();
    regionData = { buffer: e8.bufferName()!, start: e8.makeMarker(start), end: e8.makeMarker(end, { advances: true }), names, predicate: sameStart, props };
    if (!truthyValue(e8.variable("completion-in-region-mode"))) e8.callWithPrefix(1, "completion-in-region-mode");
    completionHelp(start, end, names, props);
  },
});

e8.defalias("complete-symbol", "completion-at-point");
e8.bindKey("C-M-i", "completion-at-point");

// *Completions*, as simple.el's completion-list-mode.

/** Runs BODY in the window showing *Completions*, listing them first if none does, as with-minibuffer-completions-window. */
function inCompletionsWindow(body: () => void): void {
  let window = getBufferWindow(COMPLETIONS);
  if (!window && regionData) {
    completionHelp(e8.markerPosition(regionData.start)!, e8.markerPosition(regionData.end)!, regionData.names, regionData.props);
    window = getBufferWindow(COMPLETIONS);
  }
  if (window) withSelectedWindow(window, body);
}

/** Moves to the completion N on in *Completions*, back for a negative N, as next-completion. */
function nextCompletion(n: number): void {
  const wrap = truthyValue(e8.variable("completion-auto-wrap"));
  const mouse = (p: number) => e8.getTextProperty(p, "mouse-face") !== undefined;
  if (e8.point() === e8.pointMin() && n > 0 && mouse(e8.point()) && e8.getTextProperty(e8.point(), "first-completion") === undefined) {
    e8.letBind({ "inhibit-read-only": true }, () => e8.withSilentModifications(() => e8.putTextProperty(e8.point(), e8.point() + 1, "first-completion", true)));
    n--;
  }
  for (; n > 0; n--) {
    let pos: number | undefined = e8.point();
    if (mouse(pos)) pos = e8.nextSinglePropertyChange(pos, "mouse-face");
    if (pos !== undefined) pos = e8.nextSinglePropertyChange(pos, "mouse-face");
    if (pos !== undefined) e8.gotoChar(pos);
    else if (wrap) firstCompletion();
  }
  for (; n < 0; n++) {
    let pos: number | undefined = e8.point();
    if (mouse(pos) && pos > e8.pointMin() && mouse(pos - 1)) pos = e8.previousSinglePropertyChange(pos, "mouse-face");
    if (pos !== undefined) pos = e8.previousSinglePropertyChange(pos, "mouse-face");
    if (pos !== undefined) {
      e8.gotoChar(pos);
      if (!mouse(e8.point())) e8.gotoChar(e8.previousSinglePropertyChange(e8.point(), "mouse-face") ?? e8.pointMin());
    } else if (wrap) lastCompletion();
  }
}

function firstCompletion(): void {
  e8.gotoChar(e8.pointMin());
  if (e8.getTextProperty(e8.point(), "mouse-face") === undefined) {
    const pos = e8.nextSinglePropertyChange(e8.point(), "mouse-face");
    if (pos !== undefined) e8.gotoChar(pos);
  }
}

function lastCompletion(): void {
  e8.gotoChar(e8.previousSinglePropertyChange(e8.pointMax(), "mouse-face") ?? e8.pointMin());
  if (e8.getTextProperty(e8.point(), "mouse-face") === undefined) {
    const pos = e8.previousSinglePropertyChange(e8.point(), "mouse-face");
    if (pos !== undefined) e8.gotoChar(pos);
  }
}

/** The completion at P in *Completions*, point by default, or Emacs's error, as choose-completion finds it. */
function completionHere(p = e8.point()): string {
  let beg: number;
  if (p < e8.pointMax() && e8.getTextProperty(p, "completion--string") !== undefined) beg = p + 1;
  else if (p > e8.pointMin() && e8.getTextProperty(p - 1, "completion--string") !== undefined) beg = p;
  else e8.signal("error", "No completion here");
  beg = e8.previousSinglePropertyChange(beg, "completion--string") ?? beg;
  return String(e8.getTextProperty(beg, "completion--string"));
}

/**
 * Puts the completion at point in *Completions* in place of the text it
 * completes, and takes the list away, as choose-completion.
 */
function chooseCompletion(noQuit = false, at?: number): void {
  const choice = completionHere(at);
  const data = listData;
  const reference = data && e8.getBuffer(data.reference);
  if (!data || !reference || !e8.bufferLiveP(reference)) e8.signal("error", "Destination buffer is dead");
  const window = e8.selectedWindow();
  if (!noQuit && e8.windowBuffer(window) === COMPLETIONS) quitWindow(null, window);
  e8.withCurrentBuffer(data.reference, () => {
    const start = e8.markerPosition(data.start)!;
    const end = Math.min(e8.markerPosition(data.end)!, e8.pointMax());
    completionReplace(start, end, choice);
    e8.setMarker(data.end, e8.point());
    const shown = getBufferWindow(data.reference);
    if (shown) e8.setWindowPoint(shown, e8.point());
    const names = data.names();
    // As the insert-choice function: finished, there being no boundaries.
    completionDone(choice, "finished", names, data.props.exitFunction);
  });
}

const listCommand = (name: string, doc: string, run: (n: number) => void) =>
  e8.defineCommand({ name, doc, params: [{ name: "n", kind: "count" }], run: (n: number) => run(n ?? 1) });

listCommand("next-completion", "Move to the next completion in *Completions*, or the Nth with a prefix argument.", (n) => {
  nextCompletion(n);
  highlightChosen();
});
listCommand("previous-completion", "Move to the previous completion in *Completions*, or the Nth back with a prefix argument.", (n) => {
  nextCompletion(-n);
  highlightChosen();
});
e8.defineCommand({ name: "first-completion", doc: "Move to the first completion in *Completions*.", run: () => (firstCompletion(), highlightChosen()) });
e8.defineCommand({ name: "last-completion", doc: "Move to the last completion in *Completions*.", run: () => (lastCompletion(), highlightChosen()) });
e8.defineCommand({
  name: "choose-completion",
  doc: "Put the completion at point, or where the mouse was clicked, in place of the text it completes, and take the list away.",
  run: () => {
    // From a click, the completion under it, as choose-completion reads its event.
    const event = /mouse/.test(e8.thisCommandKeys()) ? e8.lastMouseEvent() : undefined;
    if (event?.window !== undefined && event.position !== undefined && e8.windowBuffer(event.window) === COMPLETIONS)
      withSelectedWindow(event.window, () => chooseCompletion(false, event.position));
    else chooseCompletion();
  },
});

// A click on a completion chooses it, as mouse-1 follows a mouse-face link
// there with mouse-1-click-follows-link: once mouse-set-point, which E8's
// <mouse-1> runs wherever the click lands, has gone to it.
e8.adviceAdd("mouse-set-point", "after", () => {
  if (e8.windowBuffer(e8.selectedWindow()) !== COMPLETIONS || !/mouse-1/.test(e8.thisCommandKeys())) return;
  // On the completion, which has mouse-face; a click on its annotation only moves there.
  if (e8.getTextProperty(e8.point(), "mouse-face") !== undefined) chooseCompletion();
});
e8.defineCommand({
  name: "delete-completion-window",
  doc: "Take *Completions* away.",
  run: () => {
    const window = getBufferWindow(COMPLETIONS);
    if (window) quitWindow(null, window);
  },
});

listCommand("minibuffer-next-completion", "Move to the next completion in *Completions*, from the text being completed.", (n) =>
  inCompletionsWindow(() => {
    nextCompletion(n);
    highlightChosen();
  }),
);
listCommand("minibuffer-previous-completion", "Move to the previous completion in *Completions*, from the text being completed.", (n) =>
  inCompletionsWindow(() => {
    nextCompletion(-n);
    highlightChosen();
  }),
);
e8.defineCommand({
  name: "minibuffer-choose-completion",
  doc: "Put the completion moved to in *Completions* in place of the text being completed, and take the list away.",
  run: () => inCompletionsWindow(() => chooseCompletion()),
});

e8.defineMajorMode({
  name: "completion-list-mode",
  parent: "special-mode",
  modeName: "Completion List",
  doc: "The list of completions *Completions* shows: RET or a click on one puts it in place of the text it completes; TAB and S-TAB move among them.",
  bindings: {
    RET: "choose-completion",
    "<mouse-1>": "choose-completion",
    "<mouse-2>": "choose-completion",
    "ESC ESC ESC": "delete-completion-window",
    "<left>": "previous-completion",
    "<right>": "next-completion",
    TAB: "next-completion",
    "<backtab>": "previous-completion",
    "M-<up>": "minibuffer-previous-completion",
    "M-<down>": "minibuffer-next-completion",
    "M-RET": "minibuffer-choose-completion",
    n: "next-completion",
    p: "previous-completion",
  },
});

// Completion for scripts that show it their own way, as vertico does: the
// open prompt's completions in each style, styles that packages add, as
// orderless does to completion-styles-alist, and the prompt's metadata,
// as completion-metadata gives it.

e8.defineVariable({
  name: "completion-styles-alist",
  doc: "The completion styles there are, as [name, doc] pairs: those E8 has built in and those packages add with defineCompletionStyle.",
  value: [
    ["basic", "Completion of the prefix before point and the suffix after point."],
    ["partial-completion", "Completion of multiple words, each one taken as a prefix."],
    ["substring", "Completion of the string taken as a substring."],
    ["flex", "Completion of an in-order subset of characters."],
    ["emacs22", "Prefix completion that only operates on the text before point."],
  ],
});

/** The open prompt's input, split as completion-boundaries splits it, with what it completes against. */
export interface CompletionField {
  base: string;
  before: string;
  after: string;
  suffix: string;
  names: string[];
}

/** What a completion style finds: the matches, and how to highlight one, as completion-lazy-hilit-fn. */
export interface StyleMatches {
  completions: string[];
  hilit?: (candidate: string) => string | e8.PropertizedString;
}

/** A completion style a package adds, as an entry of completion-styles-alist. */
export interface CompletionStyle {
  doc: string;
  /** The names the field matches, as the style's all-completions function. */
  all: (field: CompletionField, ignoreCase: boolean) => StyleMatches | undefined;
}

const scriptStyles = new Map<string, CompletionStyle>();

/** Adds a completion style, for completion-styles to name, as an entry of completion-styles-alist. */
export function defineCompletionStyle(name: string, style: CompletionStyle): void {
  scriptStyles.set(name, style);
  const alist = e8.variable("completion-styles-alist");
  const entries = Array.isArray(alist) ? (alist as e8.Value[][]).filter((e) => e[0] !== name) : [];
  e8.setDefault("completion-styles-alist", [...entries, [name, style.doc]]);
}

/** The metadata of a completion table, as Emacs's completion metadata: what kind of things it completes and how to show them. */
export interface CompletionMetadata {
  category?: string;
  /** Text to show after a candidate. */
  annotationFunction?: (candidate: string) => string | e8.PropertizedString | undefined;
  /** Each candidate with text to show before and after it, as [candidate, prefix, suffix]. */
  affixationFunction?: (candidates: string[]) => [string, string | e8.PropertizedString, string | e8.PropertizedString][];
  /** A candidate's group title, or with `transform` the candidate as shown in its group. */
  groupFunction?: (candidate: string, transform: boolean) => string | undefined;
  /** How to order the candidates for showing them. */
  displaySortFunction?: (candidates: string[]) => string[];
  cycleSortFunction?: (candidates: string[]) => string[];
  /** How much of the input completion leaves alone, as a table's completion-boundaries: the rest is matched against the candidates. */
  boundaries?: (input: string) => number;
}

/** The metadata each open prompt's caller gave, by minibuffer depth. */
const metadataByDepth = new Map<number, CompletionMetadata>();

/**
 * Reads with completion, as completingRead does, the table's metadata
 * given too, as a completion table gives Emacs's completing-read its
 * metadata: annotations, groups, a sort.
 */
export function completingReadWithMetadata(
  prompt: string,
  collection: e8.CompletionTable,
  options: e8.CompletingReadOptions & { metadata?: CompletionMetadata } = {},
): string {
  const { metadata, ...rest } = options;
  const depth = e8.minibufferDepth() + 1;
  const old = metadataByDepth.get(depth);
  if (metadata) metadataByDepth.set(depth, { ...metadata, category: metadata.category ?? rest.category });
  try {
    return e8.completingRead(prompt, collection, { ...rest, category: rest.category ?? metadata?.category });
  } finally {
    if (old) metadataByDepth.set(depth, old);
    else metadataByDepth.delete(depth);
  }
}

/** A property of the open prompt's metadata, as completion-metadata-get: marginalia advises it to give annotations by category. */
export function completionMetadataGet<K extends keyof CompletionMetadata>(prop: K): CompletionMetadata[K] | undefined {
  return e8.funcall("completion-metadata-get", prop) as CompletionMetadata[K] | undefined;
}

e8.defun("completion-metadata-get", (prop: string) => {
  const own = metadataByDepth.get(e8.minibufferDepth());
  if (prop === "category") return own?.category ?? e8.minibufferInfo()?.category ?? undefined;
  return own?.[prop as keyof CompletionMetadata];
});

/** Highlights the part of CANDIDATE a built-in style matched, in completions-common-part, as completion-hilit-commonality does. */
function builtinHilit(style: string, field: CompletionField, ignoreCase: boolean): ((candidate: string) => string | e8.PropertizedString) | undefined {
  const typed = field.before;
  if (typed === "") return undefined;
  const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  return (candidate) => {
    const at = style === "substring" ? fold(candidate).indexOf(fold(typed)) : fold(candidate).startsWith(fold(typed)) ? 0 : -1;
    if (at < 0) return candidate;
    return e8.concat(candidate.slice(0, at), e8.propertize(candidate.slice(at, at + typed.length), { face: "completions-common-part" }), candidate.slice(at + typed.length));
  };
}

/**
 * The open prompt's completions in the first of its styles that finds any,
 * as completion-all-completions, with the base they go after and how to
 * highlight them; undefined with no prompt that completes.
 */
export function completionAllCompletions(point?: number): (StyleMatches & { base: string; style?: string; field: CompletionField }) | undefined {
  let field = e8.minibufferCompletionField(point);
  if (!field) return undefined;
  const boundaries = completionMetadataGet("boundaries");
  if (boundaries) {
    const whole = field.before + field.after;
    const n = Math.min(boundaries(whole), whole.length);
    const cut = Math.min(n, field.before.length);
    field = { ...field, base: field.base + whole.slice(0, n), before: field.before.slice(cut), after: n > field.before.length ? field.after.slice(n - field.before.length) : field.after };
  }
  const ignoreCase = e8.minibufferInfo()?.ignoreCase ?? false;
  for (const style of e8.completionStyles()) {
    const own = scriptStyles.get(style);
    const found: StyleMatches | undefined = own
      ? own.all(field, ignoreCase)
      : (() => {
          const completions = e8.completionAllInStyle(style, field.before, field.after, field.names, ignoreCase);
          return completions ? { completions, hilit: builtinHilit(style, field, ignoreCase) } : undefined;
        })();
    if (found && found.completions.length > 0) return { ...found, base: field.base, style, field };
  }
  return { completions: [], base: field.base, field };
}

/** Whether INPUT is an answer the open prompt takes, as test-completion: the part after the table's boundaries one of its names. */
export function testCompletion(input: string): boolean {
  const boundaries = completionMetadataGet("boundaries");
  return e8.testCompletion(boundaries ? input.slice(Math.min(boundaries(input), input.length)) : input);
}

// --- Completing buffer names and reading a variable, as minibuf.c does (ADR 0083)

/**
 * Completes `string` against the buffers' names, as Emacs's
 * internal-complete-buffer, the table read-buffer completes against:
 * with `flag` nil, the longest text all the matches start with, true when
 * `string` is the only match itself and nil when none matches, as
 * try-completion; with true, the matches, as all-completions, leaving out
 * the buffers whose names start with a space for empty input unless they
 * are all there is; with "lambda", whether `string` is a buffer's name, as
 * test-completion; with "metadata", the table's category. `predicate`, if
 * given, is called with each buffer as a name and the buffer, as
 * `[name, buffer]`, as Emacs passes the buffer list's entries.
 */
export function internalCompleteBuffer(string: string, predicate: unknown, flag: unknown): e8.Value {
  if (flag === "metadata") return ["metadata", ["category", "buffer"], ["cycle-sort-function", "identity"]];
  const fold = truthyValue(e8.variable("completion-ignore-case"));
  const norm = (s: string) => (fold ? s.toLowerCase() : s);
  const all = e8.bufferList();
  const accepts = (name: string) =>
    predicate === undefined || predicate === null || predicate === false || truthyValue(e8.funcall(predicate as string, [name, e8.getBuffer(name)]));
  const matches = all.filter((name) => norm(name).startsWith(norm(string)) && accepts(name));
  if (flag === "lambda") return matches.some((name) => norm(name) === norm(string));
  if (flag === true) {
    if (string.length > 0) return matches;
    const shown = matches.filter((name) => !name.startsWith(" "));
    // Only buffers whose names start with a space, and all of them: none is left out.
    return shown.length === 0 && matches.length === all.length ? matches : shown;
  }
  if (flag !== undefined && flag !== null && flag !== false) return null;
  return tryCompletionOf(string, matches, fold);
}

/**
 * The longest text the matches all start with, as Emacs's try-completion
 * works it out from them: true for `string` itself as the only match, and,
 * folding case, the case of a match exact but for case, else of one that
 * keeps the case typed, and what was typed when nothing is added.
 */
function tryCompletionOf(string: string, matches: string[], fold: boolean): string | boolean | null {
  const chars = (s: string) => [...s];
  const same = (a: string, b: string, ignoreCase: boolean) => a === b || (ignoreCase && a.toLowerCase() === b.toLowerCase());
  // How many characters two strings agree on, from the start, up to `n`.
  const agree = (a: string[], b: string[], n: number, ignoreCase: boolean) => {
    let i = 0;
    while (i < n && same(a[i], b[i], ignoreCase)) i++;
    return i;
  };
  const typed = chars(string);
  const keepsCase = (s: string[]) => s.length >= typed.length && agree(s, typed, typed.length, false) === typed.length;
  let best: string[] | undefined;
  let bestSize = 0;
  let count = 0;
  for (const match of matches) {
    const m = chars(match);
    if (best === undefined) {
      best = m;
      bestSize = m.length;
      count = 1;
      continue;
    }
    const compare = Math.min(bestSize, m.length);
    const size = agree(best, m, compare, fold);
    const old = best;
    if (fold) {
      const exact = size === m.length;
      if ((exact && size < best.length) || (exact === (size === best.length) && keepsCase(m) && !keepsCase(best))) best = m;
    }
    // The same string is not counted twice.
    if (bestSize !== m.length || bestSize !== size || (fold && agree(old, m, compare, false) !== compare)) count += count <= 1 ? 1 : 0;
    bestSize = size;
  }
  if (best === undefined) return null;
  if (fold && bestSize === typed.length && best.length > bestSize) return string;
  if (count === 1 && best.join("") === string) return true;
  return best.slice(0, bestSize).join("");
}
e8.defun("internal-complete-buffer", internalCompleteBuffer);

/** Whether a Lisp value is true, nil and false being false. */
function truthyValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * Reads a variable's name in the minibuffer and returns it, as Emacs's
 * read-variable: completing against the variables, one of which must be
 * chosen, with `defaultValue`, or the first of a list of them, for empty
 * input. Emacs offers only user options, which E8 does not tell apart, so
 * every variable is offered.
 */
export function readVariable(prompt: string, defaultValue?: string | string[] | null): string {
  const first = Array.isArray(defaultValue) ? defaultValue[0] : defaultValue;
  return e8.completingRead(prompt, [...e8.variableNames()].sort(), {
    requireMatch: true,
    history: "custom-variable-history",
    ...(first ? { default: first } : {}),
  });
}
e8.defun("read-variable", readVariable);
e8.defineVariable({ name: "custom-variable-history", doc: "Variable names read-variable was answered with, newest first.", value: [] });

// minibuf.c's readers by their names (ADR 0090).

/** Reads a buffer's name with completion, as read-buffer: DEF the default, REQUIRE-MATCH as completing-read's. */
export function readBuffer(prompt: string, def?: string | e8.Buffer | null, requireMatch?: e8.Value, predicate?: (name: string) => boolean): string {
  const fallback = def === null || def === undefined ? undefined : typeof def === "string" ? def : (def.name ?? undefined);
  // Not the internal buffers, whose names start with a space, as
  // internal-complete-buffer leaves them out.
  const names = e8.bufferList().filter((n) => !n.startsWith(" ") && (predicate === undefined || predicate(n)));
  // The default in the prompt, before its colon, as read-buffer puts it with format-prompt.
  const shown = fallback === undefined ? prompt : `${prompt.replace(/: $|[: ]$/, "")} (default ${fallback}): `;
  return e8.completingRead(shown, names, { requireMatch: requireMatch !== null && requireMatch !== undefined && requireMatch !== false, default: fallback });
}
e8.defun("read-buffer", readBuffer);

/** Reads a command's name with completion, as read-command. */
export function readCommand(prompt: string, def?: string | null): string {
  return e8.completingRead(prompt, e8.commandNames(), { requireMatch: true, default: def ?? undefined });
}
e8.defun("read-command", readCommand);
