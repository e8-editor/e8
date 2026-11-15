// Incremental search, after Emacs's isearch.el. C-s and C-r search as you
// type, from point. While searching, isearch-mode-map overrides every other
// keymap: printing characters extend the search string, C-s and C-r find the
// next match, DEL takes back the last change, RET ends the search, and C-g
// cancels it. Any other key ends the search and then does what it usually
// does. The current match is highlighted with the isearch face and the other
// matches nearby with lazy-highlight.
//
// The search keeps isearch.el's state in its variables (isearch-string,
// isearch-forward, isearch-success, isearch-error, isearch-other-end and the
// rest) and a stack of states that DEL pops, so a mode can search something
// other than the buffer's text as Emacs's modes do: isearch-mode-hook runs
// as a search starts and isearch-mode-end-hook as it ends, and
// isearch-search-fun-function, isearch-message-function,
// isearch-wrap-function and isearch-push-state-function replace how it
// searches, what it says, how it wraps and what each state keeps, as
// comint.ts's history search does.

import { truthy, regexpQuote } from "subr";

e8.defineFace({
  name: "isearch",
  doc: "The match incremental search is at.",
  // Text on Lavender is dark in both appearances: the page's colour in the
  // dark, the strongest ink in the light, never the light page's ivory.
  attributes: { background: "accent" },
  dark: { foreground: "bg" },
  light: { foreground: "ink-strong" },
});
e8.defineFace({
  name: "lazy-highlight",
  doc: "Other matches for the string incremental search is looking for.",
  attributes: { background: "selection" },
});
e8.defineFace({
  name: "isearch-fail",
  doc: "The part of the search string that does not match.",
  attributes: { background: "bad", foreground: "bg" },
});

for (const [name, doc, value, local] of [
  ["search-ring", "Strings searched for with incremental search, most recent first.", [], false],
  ["regexp-search-ring", "Regular expressions searched for with incremental search, most recent first.", [], false],
  ["search-ring-max", "How many strings search-ring keeps.", 16, false],
  ["regexp-search-ring-max", "How many regular expressions regexp-search-ring keeps.", 16, false],
  ["lazy-highlight-max-at-a-time", "How many other matches incremental search highlights at most, around point.", 200, false],
  [
    "search-upper-case",
    "Whether a capital letter in the search string makes the search case-sensitive: not-yanks, the default, as t except that text yanked into the string is lowercased first.",
    "not-yanks",
    false,
  ],
  ["isearch-search-fun-function", "The function that gives the function isearch searches with, called with no arguments; the function it gives takes the string, a bound and noerror, as re-search-forward does, and moves point to the match.", "isearch-search-fun-default", false],
  ["isearch-message-function", "The function that says where the search stands, instead of isearch-message, or nil.", null, false],
  ["isearch-wrap-function", "The function that moves point to where a failing search wraps round to, instead of the other end of the buffer, or nil.", null, false],
  ["isearch-push-state-function", "A function called as each state of the search is saved, which gives a function the state is restored with when DEL goes back to it, or nil.", null, false],
  ["isearch-filter-predicate", "A function of a match's start and end that says whether the search may stop there.", "isearch-filter-visible", false],
  ["isearch-message-prefix-add", "Text added before \"I-search\" in the search's prompt, such as \"history \".", null, false],
  ["isearch-lazy-count", "Whether the prompt counts the matches.", false, false],
  ["isearch-repeat-on-direction-change", "Whether C-r after C-s, or C-s after C-r, first goes to the other end of the match, so the next search finds the one after it.", false, false],
  ["isearch-mode", "\" Isearch\" while a search is going on, else nil.", null, false],
  ["isearch-string", "The string being searched for.", "", false],
  ["isearch-message", "The search string as the prompt shows it, control characters as ^X.", "", false],
  ["isearch-forward", "Whether the search goes forward.", true, false],
  ["isearch-regexp", "Whether the search is for a regular expression.", false, false],
  ["isearch-success", "Whether the search has found the string.", true, false],
  ["isearch-error", "Why the string cannot be searched for, such as an unfinished regexp, or nil.", null, false],
  ["isearch-wrapped", "Whether the search has wrapped round the end of the buffer.", false, false],
  ["isearch-barrier", "Where the search may not move back past while the string grows, as a regexp's \\| widens it.", 0, false],
  ["isearch-opoint", "Where point was when the search began, where the mark goes when it ends.", 0, false],
  ["isearch-other-end", "The other end of the match from point.", null, false],
  ["isearch-case-fold-search", "Whether the search ignores case: t, nil, or yes after M-c.", true, false],
  ["isearch-nonincremental", "Whether the search is a nonincremental one.", false, false],
  ["isearch-suspended", "Whether the search is suspended to read from the minibuffer.", false, false],
  ["isearch-adjusted", "Whether point has been moved back so that the string may match from further back.", false, false],
  ["isearch-yank-flag", "Whether text was just yanked into the search string.", false, false],
  ["isearch-mode-end-hook-quit", "Whether the search being ended was cancelled, while isearch-mode-end-hook runs.", false, false],
] as const) {
  e8.defineVariable({ name, doc, value: value as unknown as e8.Value, local });
}
e8.defineHook("isearch-mode-hook", "Run as a search starts, in the buffer searched.");
e8.defineHook("isearch-mode-end-hook", "Run as a search ends; isearch-mode-end-hook-quit is true if it was cancelled.");
e8.defineHook("isearch-update-post-hook", "Run after each change the search shows.");

const get = (name: string) => e8.variable(name);
const set = (name: string, value: e8.Value) => e8.setVariable(name, value);
const flag = (name: string) => truthy(get(name));
const str = (name: string) => String(get(name) ?? "");

/** One state of the search, which DEL goes back to, as isearch--state. */
interface State {
  string: string;
  message: string;
  point: number;
  success: boolean;
  forward: boolean;
  otherEnd: number | undefined;
  error: string | undefined;
  wrapped: boolean;
  barrier: number;
  caseFold: e8.Value;
  popFun: e8.Value | undefined;
  match: { start: number; end: number } | undefined;
}

/** The states, the newest first, as isearch-cmds. */
let cmds: State[] = [];
/** Whether the search has not yet searched, as isearch-just-started. */
let justStarted = false;
/** The case folding before this search began, as isearch-last-case-fold-search. */
let lastCaseFold: e8.Value = true;
/** The match isearch-search found, as isearch-match-data. */
let matchData: { start: number; end: number } | undefined;
/** Where yanking a word goes on from after a failing search, as isearch--yank-prev-point. */
let yankPrevPoint: number | undefined;
/** The overlays on the match and the other matches. */
let current: number | undefined;
let others: number[] = [];

function getState(): State {
  const pushFn = get("isearch-push-state-function");
  return {
    string: str("isearch-string"),
    message: str("isearch-message"),
    point: e8.point(),
    success: flag("isearch-success"),
    forward: flag("isearch-forward"),
    otherEnd: (get("isearch-other-end") as number | null) ?? undefined,
    error: (get("isearch-error") as string | null) ?? undefined,
    wrapped: flag("isearch-wrapped"),
    barrier: Number(get("isearch-barrier") ?? 0),
    caseFold: get("isearch-case-fold-search") ?? null,
    popFun: truthy(pushFn) ? (e8.funcall(pushFn as string) as e8.Value) : undefined,
    match: matchData,
  };
}

/** Makes a state the search's, as isearch--set-state. */
function setState(cmd: State): void {
  set("isearch-string", cmd.string);
  set("isearch-message", cmd.message);
  set("isearch-success", cmd.success);
  set("isearch-forward", cmd.forward);
  set("isearch-other-end", cmd.otherEnd ?? null);
  set("isearch-error", cmd.error ?? null);
  set("isearch-wrapped", cmd.wrapped);
  set("isearch-barrier", cmd.barrier);
  set("isearch-case-fold-search", cmd.caseFold);
  matchData = cmd.match;
  if (typeof cmd.popFun === "function" || (typeof cmd.popFun === "string" && e8.fboundp(cmd.popFun))) e8.funcall(cmd.popFun as string, cmd as unknown as e8.Value);
  e8.gotoChar(cmd.point);
}

const pushState = () => cmds.unshift(getState());
function popState(): void {
  cmds.shift();
  setState(cmds[0]);
}

/** How the prompt shows a character: control characters as ^X, as isearch-text-char-description. */
function charDescription(text: string): string {
  return [...text].map((c) => {
    const code = c.codePointAt(0)!;
    if (code < 32 && c !== "\t" && c !== "\n") return `^${String.fromCharCode(code + 64)}`;
    if (code === 127) return "^?";
    return c;
  }).join("");
}

/** Whether a string has no capital letters, those quoted with \ in a regexp aside, as isearch-no-upper-case-p. */
export function isearchNoUpperCaseP(string: string, regexp: boolean): boolean {
  let quote = false;
  for (const c of string) {
    if (regexp && c === "\\") quote = !quote;
    else {
      if (!quote && c !== c.toLowerCase()) return false;
      quote = false;
    }
  }
  return !(regexp && /\[:(upp|low)er:\]/.test(string));
}

/** The search's prompt up to the string, as isearch-message-prefix: "Failing wrapped regexp I-search backward: " and the like. */
export function isearchMessagePrefix(ellipsis = false, nonincremental = flag("isearch-nonincremental")): string {
  const success = flag("isearch-success");
  const forward = flag("isearch-forward");
  const wrapped = flag("isearch-wrapped");
  const opoint = Number(get("isearch-opoint") ?? 0);
  void ellipsis;
  const m =
    (success ? "" : "failing ") +
    (get("isearch-adjusted") === true ? "pending " : "") +
    (wrapped && !truthy(get("isearch-wrap-function")) && (forward ? e8.point() > opoint : e8.point() < opoint) ? "over" : "") +
    (wrapped ? "wrapped " : "") +
    (!success && !truthy(get("isearch-case-fold-search")) ? "case-sensitive " : "") +
    (flag("isearch-regexp") ? "regexp " : "") +
    str("isearch-message-prefix-add") +
    (nonincremental ? "search" : "I-search") +
    (forward ? "" : " backward") +
    ": ";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function messageSuffix(): string {
  const error = get("isearch-error");
  return truthy(error) ? ` [${String(error)}]` : "";
}

/** Says where the search stands in the echo area, as isearch-message. */
export function isearchMessage(_cqHack = false, ellipsis = false): void {
  e8.letBind({ "message-log-max": null }, () => e8.message(isearchMessagePrefix(ellipsis) + str("isearch-message") + messageSuffix()));
}
e8.defun("isearch-message", (cq?: e8.Value, ellipsis?: e8.Value) => isearchMessage(truthy(cq), truthy(ellipsis)));

function callMessage(cqHack = false, ellipsis = false): void {
  const f = get("isearch-message-function");
  if (truthy(f)) e8.funcall(f as string, cqHack, ellipsis);
  else isearchMessage(cqHack, ellipsis);
}

/** The function searching the buffer for the string as a regexp or literally, in the search's direction, as isearch-search-fun-default gives. */
export function isearchSearchFunDefault(): (string: string, bound?: e8.Value, noerror?: e8.Value) => number | undefined {
  return (string, bound, noerror) => {
    const forward = flag("isearch-forward");
    const options = { bound: typeof bound === "number" ? bound : undefined, noerror: truthy(noerror) };
    if (flag("isearch-regexp")) return forward ? e8.reSearchForward(string, options) : e8.reSearchBackward(string, options);
    // A string is searched for literally, as search-forward does, which is
    // far faster in a large buffer than the regexp engine on it quoted.
    const m = e8.search(string, { backward: !forward, bound: options.bound });
    if (m === undefined) {
      if (options.noerror) return undefined;
      e8.signal("search-failed", `Search failed: "${string}"`, [string]);
    }
    e8.gotoChar(forward ? m!.end : m!.start);
    return e8.point();
  };
}
e8.defun("isearch-search-fun-default", isearchSearchFunDefault);

/** The function to search with, as isearch-search-fun: what isearch-search-fun-function gives. */
export function isearchSearchFun(): (string: string, bound?: e8.Value, noerror?: e8.Value) => number | undefined {
  const f = get("isearch-search-fun-function");
  if (!truthy(f) || f === "isearch-search-fun-default") return isearchSearchFunDefault();
  return e8.funcall(f as string) as unknown as (string: string, bound?: e8.Value, noerror?: e8.Value) => number | undefined;
}

e8.defun("isearch-filter-visible", () => true);

/** Searches for the string, moving point to the match if found, as isearch-search-string. */
function searchString(string: string, bound: number | undefined, noerror: boolean): number | undefined {
  const fn = isearchSearchFun();
  const pos = e8.saveExcursion(() => fn(string, bound ?? null, noerror));
  if (pos === undefined || pos === null) return undefined;
  e8.gotoChar(pos);
  return pos;
}

/** Searches with the current string, as isearch-search: sets isearch-success and isearch-error, and goes back to the last state's point if it fails. */
function isearchSearch(): void {
  if (get("isearch-case-fold-search") === true && truthy(get("search-upper-case"))) {
    set("isearch-case-fold-search", isearchNoUpperCaseP(str("isearch-string"), flag("isearch-regexp")));
  }
  e8.conditionCase(
    () =>
      e8.letBind({ "case-fold-search": truthy(get("isearch-case-fold-search")) }, () => {
        set("isearch-error", null);
        const filter = get("isearch-filter-predicate");
        for (;;) {
          const found = searchString(str("isearch-string"), undefined, true) !== undefined;
          set("isearch-success", found);
          if (!found) break;
          const [b, e] = [e8.matchBeginning(0)!, e8.matchEnd(0)!];
          if (!truthy(filter) || filter === "isearch-filter-visible" || truthy(e8.funcall(filter as string, b, e))) break;
          if (b === e) {
            const forward = flag("isearch-forward");
            if (forward ? e8.point() >= e8.pointMax() : e8.point() <= e8.pointMin()) {
              set("isearch-success", false);
              break;
            }
            e8.gotoChar(e8.point() + (forward ? 1 : -1));
          }
        }
        justStarted = false;
        if (flag("isearch-success")) {
          const [b, e] = [e8.matchBeginning(0)!, e8.matchEnd(0)!];
          set("isearch-other-end", flag("isearch-forward") ? b : e);
          matchData = { start: b, end: e };
        }
      }),
    {
      "invalid-regexp": (e) => {
        const message = String(e.data[0] ?? e.message);
        set("isearch-error", /^(Premature |Unmatched )/.test(message) ? "incomplete input" : message);
      },
      "search-failed": (e) => {
        set("isearch-success", false);
        set("isearch-error", (e.data[1] as string | undefined) ?? null);
      },
      error: (e) => set("isearch-error", e.message),
    },
  );
  if (!flag("isearch-success")) {
    const top = cmds[0];
    if (typeof top.popFun === "function" || (typeof top.popFun === "string" && e8.fboundp(top.popFun))) e8.funcall(top.popFun as string, top as unknown as e8.Value);
    e8.gotoChar(top.point);
  }
}

function clearHighlights(): void {
  if (current !== undefined) e8.deleteOverlay(current);
  current = undefined;
  for (const id of others) e8.deleteOverlay(id);
  others = [];
}

/** Highlights the other matches within a few hundred lines, searching forward with bounds as lazy highlighting does. */
function lazyHighlight(): void {
  const string = str("isearch-string");
  if (string === "" || truthy(get("isearch-error"))) return;
  const max = Number(get("lazy-highlight-max-at-a-time") ?? 200);
  const line = e8.lineOf(e8.point());
  const from = e8.lineStart(Math.max(0, line - 100));
  const to = e8.lineEnd(Math.min(e8.lineCount() - 1, line + 100));
  const forward = get("isearch-forward") ?? true;
  e8.saveExcursion(() =>
    e8.letBind({ "case-fold-search": truthy(get("isearch-case-fold-search")) }, () => {
      set("isearch-forward", true);
      try {
        const fn = isearchSearchFun();
        e8.gotoChar(from);
        while (others.length < max) {
          const found = e8.ignoreErrors(() => fn(string, to, true));
          if (found === undefined || found === null) break;
          const [b, e] = [e8.matchBeginning(0)!, e8.matchEnd(0)!];
          if (b === e) {
            if (e8.point() >= to) break;
            e8.gotoChar(e8.point() + 1);
            continue;
          }
          if (!(matchData && b === matchData.start && e === matchData.end)) others.push(e8.makeOverlay(b, e, { face: "lazy-highlight", priority: 1000 }));
        }
      } finally {
        set("isearch-forward", forward);
      }
    }),
  );
}

/** Shows the search as it stands: the prompt, the match and the others, as isearch-update. */
function isearchUpdate(): void {
  callMessage();
  clearHighlights();
  const otherEnd = get("isearch-other-end");
  if (typeof otherEnd === "number" && otherEnd !== e8.point() && flag("isearch-success")) {
    current = e8.makeOverlay(Math.min(otherEnd, e8.point()), Math.max(otherEnd, e8.point()), { face: "isearch", priority: 1001 });
  }
  set("isearch-adjusted", false);
  set("isearch-yank-flag", false);
  e8.runHooks("isearch-update-post-hook");
  lazyHighlight();
}

/** Adds a string to the front of the ring, as isearch-update-ring. */
function updateRing(string: string, regexp: boolean): void {
  const name = regexp ? "regexp-search-ring" : "search-ring";
  const ring = get(name);
  const previous = Array.isArray(ring) ? ring.filter((s) => typeof s === "string" && s !== string) : [];
  set(name, [string, ...previous].slice(0, Number(get(regexp ? "regexp-search-ring-max" : "search-ring-max") ?? 16)) as e8.Value);
}

function ring(regexp: boolean): string[] {
  const value = get(regexp ? "regexp-search-ring" : "search-ring");
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Starts a search, as isearch-mode. */
export function isearchMode(forward: boolean, regexp = false): void {
  set("isearch-forward", forward);
  set("isearch-regexp", regexp);
  lastCaseFold = get("isearch-case-fold-search") ?? true;
  set("isearch-case-fold-search", truthy(get("case-fold-search")));
  set("isearch-string", "");
  set("isearch-message", "");
  cmds = [];
  set("isearch-success", true);
  set("isearch-wrapped", false);
  set("isearch-barrier", e8.point());
  set("isearch-adjusted", false);
  set("isearch-yank-flag", false);
  set("isearch-error", null);
  set("isearch-other-end", null);
  justStarted = true;
  matchData = undefined;
  yankPrevPoint = undefined;
  set("isearch-opoint", e8.point());
  set("isearch-mode", " Isearch");
  e8.setOverridingMap("isearch-mode-map");
  e8.runHooks("isearch-mode-hook");
  pushState();
  isearchUpdate();
}

/** Whether a search is going on. */
const searching = () => get("isearch-mode") !== null && get("isearch-mode") !== undefined;

/** Ends the search, as isearch-done: with `nopush` the string is not added to the ring. */
export function isearchDone(nopush = false, edit = false): void {
  e8.setOverridingMap(null);
  clearHighlights();
  set("isearch-mode", null);
  const string = str("isearch-string");
  if (string !== "" && !nopush) updateRing(string, flag("isearch-regexp"));
  e8.letBind({ "isearch-mode-end-hook-quit": nopush && !edit }, () => e8.runHooks("isearch-mode-end-hook"));
  const opoint = Number(get("isearch-opoint") ?? e8.point());
  if (e8.point() !== opoint) {
    if (!(truthy(get("transient-mark-mode")) && e8.regionActive())) {
      e8.pushMark(opoint);
      if (e8.minibufferDepth() === 0 && !edit) e8.message("Mark saved where search started");
    }
  } else if (!edit) e8.message("");
}

function requireSearch(): void {
  if (!searching()) e8.userError("Not searching");
}

/** Searches again with the string grown, as isearch-search-and-update. */
function searchAndUpdate(): void {
  if (flag("isearch-success") || flag("isearch-regexp")) {
    const forward = flag("isearch-forward");
    const opoint = Number(get("isearch-opoint"));
    const barrier = Number(get("isearch-barrier"));
    // Searching back, the longer string may match where point is, as long as it ends before where the search began.
    let matchedHere = false;
    if (!forward && !flag("isearch-adjusted")) {
      const string = str("isearch-string");
      let fold = truthy(get("isearch-case-fold-search"));
      if (get("isearch-case-fold-search") === true && truthy(get("search-upper-case"))) fold = isearchNoUpperCaseP(string, flag("isearch-regexp"));
      const here = e8.ignoreErrors(() => e8.lookingAt(flag("isearch-regexp") ? string : regexpQuote(string), undefined, { caseFold: fold }));
      matchedHere = here === true && (flag("isearch-yank-flag") || e8.matchEnd(0)! <= Math.min(opoint, barrier));
    }
    if (matchedHere) {
      set("isearch-success", true);
      set("isearch-error", null);
      set("isearch-other-end", e8.matchEnd(0)!);
      matchData = { start: e8.matchBeginning(0)!, end: e8.matchEnd(0)! };
      if (get("isearch-case-fold-search") === true && truthy(get("search-upper-case"))) {
        set("isearch-case-fold-search", isearchNoUpperCaseP(str("isearch-string"), flag("isearch-regexp")));
      }
    } else {
      callMessage(false, true);
      const otherEnd = get("isearch-other-end");
      if (typeof otherEnd === "number" && !flag("isearch-adjusted")) {
        e8.gotoChar(forward ? otherEnd : Math.min(opoint, barrier, otherEnd + 1));
      }
      isearchSearch();
    }
  }
  pushState();
  isearchUpdate();
}

/** Adds text to the search string and searches again, as isearch-process-search-string. */
function processSearchString(string: string, message: string): void {
  set("isearch-string", str("isearch-string") + string);
  set("isearch-message", str("isearch-message") + message);
  searchAndUpdate();
}

/** Adds yanked text to the search string, as isearch-yank-string: lowercased if case is ignored, quoted in a regexp. */
function yankString(string: string): void {
  if (truthy(get("isearch-case-fold-search")) && get("search-upper-case") === "not-yanks") string = string.toLowerCase();
  if (flag("isearch-regexp")) string = regexpQuote(string);
  set("isearch-yank-flag", true);
  processSearchString(string, charDescription(string));
}

/** Finds the next match in a direction, wrapping round once a search has failed, as isearch-repeat. */
function isearchRepeat(direction: "forward" | "backward", count = 1): void {
  const forward = direction === "forward";
  if (flag("isearch-forward") === forward) {
    if (str("isearch-string") === "") {
      const previous = ring(flag("isearch-regexp"))[0];
      if (previous === undefined) set("isearch-error", "No previous search string");
      else {
        set("isearch-string", previous);
        set("isearch-message", charDescription(previous));
        set("isearch-case-fold-search", lastCaseFold);
      }
    } else if (!flag("isearch-success")) {
      set("isearch-wrapped", true);
      const wrap = get("isearch-wrap-function");
      if (truthy(wrap)) e8.funcall(wrap as string);
      else e8.gotoChar(forward ? e8.pointMin() : e8.pointMax());
    }
  } else {
    const otherEnd = get("isearch-other-end");
    if (typeof otherEnd === "number" && flag("isearch-repeat-on-direction-change")) e8.gotoChar(otherEnd);
    set("isearch-forward", !flag("isearch-forward"));
    set("isearch-success", true);
  }
  set("isearch-barrier", e8.point());
  if (str("isearch-string") === "") set("isearch-success", true);
  else {
    const saved = [...cmds];
    while (count-- > 0) {
      if (flag("isearch-success") && e8.point() === get("isearch-other-end") && !justStarted) {
        // After an empty match, step on so the search moves.
        if (flag("isearch-forward") ? e8.point() >= e8.pointMax() : e8.point() <= e8.pointMin()) set("isearch-success", false);
        else {
          e8.gotoChar(e8.point() + (flag("isearch-forward") ? 1 : -1));
          isearchSearch();
        }
      } else isearchSearch();
      if (count > 0) pushState();
      if (!flag("isearch-success") || truthy(get("isearch-error"))) count = 0;
    }
    cmds = saved;
  }
  pushState();
  isearchUpdate();
}

e8.defineKeymap("isearch-mode-map");

/** C-s, C-r and their regexp forms: start a search, or while searching, find the next match. */
function startOrRepeat(forward: boolean, regexp: boolean, arg: e8.PrefixArg): void {
  if (searching()) {
    isearchRepeat(forward ? "forward" : "backward");
    return;
  }
  // A prefix argument switches between string and regexp, as isearch-forward's REGEXP-P.
  isearchMode(forward, arg === null ? regexp : !regexp);
}

const isearchForward = e8.defineCommand({
  name: "isearch-forward",
  doc:
    "Search forward incrementally: as you type, point moves to the next match of what you have typed.\n\n" +
    "C-s again finds the next match, and once a search fails, wraps round to the start. C-r searches backward. " +
    "DEL takes back the last character or step, C-w adds the next word from the buffer and C-y the last kill. " +
    "RET ends the search, leaving point at the match and the mark where the search started; any other key " +
    "does the same and then runs. C-g goes back to where the search started, or while it fails, removes " +
    "what does not match. Case is ignored unless the string has a capital letter. With a prefix argument, searches for a regexp.",
  params: [{ name: "regexp", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => startOrRepeat(true, false, arg),
});

const isearchBackward = e8.defineCommand({
  name: "isearch-backward",
  doc: "Search backward incrementally. See isearch-forward for the keys that work while searching.",
  params: [{ name: "regexp", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => startOrRepeat(false, false, arg),
});

const isearchForwardRegexp = e8.defineCommand({
  name: "isearch-forward-regexp",
  doc: "Search forward incrementally for a regular expression, in Emacs's syntax. See isearch-forward.",
  params: [{ name: "regexp", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => startOrRepeat(true, true, arg),
});

const isearchBackwardRegexp = e8.defineCommand({
  name: "isearch-backward-regexp",
  doc: "Search backward incrementally for a regular expression, in Emacs's syntax. See isearch-forward.",
  params: [{ name: "regexp", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => startOrRepeat(false, true, arg),
});

const repeatForward = e8.defineCommand({
  name: "isearch-repeat-forward",
  doc: "Find the next match forward of the string being searched for.",
  run: () => {
    requireSearch();
    isearchRepeat("forward");
  },
});

const repeatBackward = e8.defineCommand({
  name: "isearch-repeat-backward",
  doc: "Find the next match backward of the string being searched for.",
  run: () => {
    requireSearch();
    isearchRepeat("backward");
  },
});

/** The character a key types, if it is a printing character. */
function printingChar(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (key === "SPC" || key === "S-SPC") return " ";
  return Array.from(key).length === 1 ? key : undefined;
}

const printingCharCommand = e8.defineCommand({
  name: "isearch-printing-char",
  doc:
    "Add the character typed to the search string, or for any other key, end the search and run the key.\n\n" +
    "Bound as the default of isearch-mode-map, so it sees every key that map does not bind.",
  run: () => {
    const key = e8.lastKey();
    const c = printingChar(key);
    if (c !== undefined) {
      processSearchString(c, charDescription(c));
      return;
    }
    isearchDone();
    if (key !== undefined) e8.unreadKeys(key);
  },
});

const deleteChar = e8.defineCommand({
  name: "isearch-delete-char",
  doc: "Take back the last change to the search: the last character typed, or the last C-s or C-r.",
  run: () => {
    requireSearch();
    if (cmds.length > 1) popState();
    isearchUpdate();
  },
});

e8.defineCommand({
  name: "isearch-del-char",
  doc: "Take the last character off the search string and search again, keeping the effect of other commands.",
  params: [{ name: "n", kind: "count" }],
  run: (n = 1) => {
    requireSearch();
    const string = [...str("isearch-string")];
    if (string.length > 0) {
      const kept = string.slice(0, string.length - Math.min(n, string.length)).join("");
      set("isearch-string", kept);
      set("isearch-message", charDescription(kept));
    }
    callMessage(false, true);
    const otherEnd = get("isearch-other-end");
    if (typeof otherEnd === "number") e8.gotoChar(otherEnd);
    isearchSearch();
    pushState();
    isearchUpdate();
  },
});

const exit = e8.defineCommand({
  name: "isearch-exit",
  doc: "End the search, leaving point at the match and the mark where the search started.",
  run: () => {
    requireSearch();
    isearchDone();
  },
});

/** Ends the search and goes back to where it started, as isearch-cancel. */
function isearchCancel(): void {
  if (truthy(get("isearch-push-state-function")) && cmds.length > 0) setState(cmds[cmds.length - 1]);
  else e8.gotoChar(Number(get("isearch-opoint")));
  isearchDone(true);
  e8.message("Quit");
}

const abort = e8.defineCommand({
  name: "isearch-abort",
  doc: "While the search fails, remove what does not match; otherwise end it and go back to where it started.",
  run: () => {
    requireSearch();
    if (flag("isearch-success") && !truthy(get("isearch-error"))) {
      set("isearch-success", false);
      isearchCancel();
      return;
    }
    while ((!flag("isearch-success") || truthy(get("isearch-error"))) && cmds.length > 1) popState();
    isearchUpdate();
  },
});

/** Adds the text from point to where `jump` moves, as isearch-yank-internal. */
function yankInternal(jump: () => number): void {
  const text = e8.saveExcursion(() => {
    const otherEnd = get("isearch-other-end");
    if (!flag("isearch-forward") && typeof otherEnd === "number") e8.gotoChar(otherEnd);
    if (!flag("isearch-success") && yankPrevPoint !== undefined) e8.gotoChar(yankPrevPoint);
    const start = e8.point();
    const end = jump();
    yankPrevPoint = flag("isearch-success") ? undefined : end;
    return e8.bufferSubstringNoProperties(Math.min(start, end), Math.max(start, end));
  });
  yankString(text);
}

const yankWord = e8.defineCommand({
  name: "isearch-yank-word-or-char",
  doc: "Add the rest of the word after point to the search string, or the next character if point is not before a word.",
  params: [{ name: "n", kind: "count" }],
  run: (n = 1) => {
    requireSearch();
    yankInternal(() => {
      for (let i = 0; i < n; i++) {
        const word = (c: string | undefined) => c !== undefined && e8.charSyntax(c) === "w";
        if (word(e8.charAfter()) || word(e8.charAfter(e8.point() + 1))) e8.call("forward-word", 1);
        else if (e8.point() < e8.pointMax()) e8.gotoChar(e8.point() + 1);
      }
      return e8.point();
    });
  },
});

e8.defineCommand({
  name: "isearch-yank-char",
  doc: "Add the next character after point to the search string, or as many as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  run: (n = 1) => {
    requireSearch();
    yankInternal(() => {
      e8.gotoChar(Math.min(e8.pointMax(), e8.point() + n));
      return e8.point();
    });
  },
});

const yankKill = e8.defineCommand({
  name: "isearch-yank-kill",
  doc: "Add the last kill to the search string.",
  run: () => {
    if (!searching()) isearchMode(true);
    const kill = e8.currentKill();
    if (kill !== undefined) yankString(kill);
  },
});

const toggleRegexp = e8.defineCommand({
  name: "isearch-toggle-regexp",
  doc: "Switch between searching for a string and for a regular expression; what is typed next searches the new way.",
  run: () => {
    if (!searching()) isearchMode(true);
    set("isearch-regexp", !flag("isearch-regexp"));
    set("isearch-success", true);
    set("isearch-adjusted", "toggle");
    isearchUpdate();
  },
});

const toggleCaseFold = e8.defineCommand({
  name: "isearch-toggle-case-fold",
  doc: "Toggle case-fold searching on or off.\nToggles the value of the variable isearch-case-fold-search.",
  run: () => {
    if (!searching()) isearchMode(true);
    // yes rather than t, so a capital typed no longer makes it exact.
    const fold = truthy(get("isearch-case-fold-search")) ? null : "yes";
    set("isearch-case-fold-search", fold);
    set("isearch-success", true);
    set("isearch-adjusted", "toggle");
    isearchUpdate();
    // As isearch--momentary-message, after the prompt until the next key.
    e8.letBind({ "message-log-max": null }, () =>
      e8.message(`${isearchMessagePrefix(false)}${str("isearch-message")} [${fold === null ? "case sensitive" : "case insensitive"}]`),
    );
  },
});

e8.bindKey("C-s", isearchForward);
e8.bindKey("C-r", isearchBackward);
e8.bindKey("C-M-s", isearchForwardRegexp);
e8.bindKey("C-M-r", isearchBackwardRegexp);

e8.setKeymapDefault("isearch-mode-map", printingCharCommand);
for (const [keys, command] of [
  ["C-s", repeatForward],
  ["C-r", repeatBackward],
  ["C-M-s", repeatForward],
  ["C-M-r", repeatBackward],
  ["DEL", deleteChar],
  ["RET", exit],
  ["C-g", abort],
  ["C-w", yankWord],
  ["C-y", yankKill],
  ["M-r", toggleRegexp],
  ["M-s r", toggleRegexp],
  ["M-c", toggleCaseFold],
  ["M-s c", toggleCaseFold],
] as const) {
  e8.bindKey(keys, command, "isearch-mode-map");
}
