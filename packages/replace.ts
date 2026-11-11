// Replacing, after Emacs's replace.el: query-replace (M-%) and
// query-replace-regexp (C-M-%) ask at each match, and replace-string and
// replace-regexp replace every match. All of them work from point to the
// end of the buffer, or on the region when it is active and they run from
// a key or M-x.
//
// While query-replace asks, query-replace-map overrides other keymaps:
// y or SPC replaces and moves on, n or DEL skips, ! replaces the rest, . replaces
// and stops, "," replaces and stays, ^ goes back to the last match, and q or
// RET stops. Any other key stops and then runs.

import { regexpQuote } from "subr";

e8.defineFace({
  name: "query-replace",
  doc: "The match query-replace is asking about.",
  attributes: { inherit: "isearch" },
});

e8.defineVariable({
  name: "query-replace-history",
  doc: "Strings and replacements answered to query-replace and the other replace commands, newest first.",
  value: [],
});

e8.defineVariable({
  name: "case-replace",
  doc:
    "Whether replacing follows the case of the text replaced, when the search ignores case: " +
    "\"foo\" replacing \"Hello\" gives \"Foo\", and replacing \"HELLO\" gives \"FOO\".",
  value: true,
});

interface Replace {
  from: string;
  to: string;
  regexp: boolean;
  /** Whether the replacement is taken as it is, rather than with \\& and \\N. */
  literal: boolean;
  /** How the messages name what is replaced. */
  shown: string;
  caseFold: boolean;
  /** Whether the match asked about was already replaced, by ",". */
  replaced: boolean;
  /** Where the search goes on from. */
  next: number;
  count: number;
  /** The match being asked about. */
  match?: { start: number; end: number };
  /** Positions of earlier matches, for ^. */
  history: number[];
  current?: number;
  others: number[];
}

let replacing: Replace | undefined;

/** The range to work on: the active region from a key or M-x, else point to the end. */
function scope(fromPoint = false): { start: number; endMarker: number } {
  let start = e8.point();
  let end = e8.bufferSize();
  if (!fromPoint && e8.calledInteractively() && e8.regionActive()) {
    const mark = e8.mark() ?? start;
    end = Math.max(mark, start);
    start = Math.min(mark, start);
    e8.deactivateMark();
  }
  // An overlay keeps the end in place as replacements change the text before it.
  const endMarker = e8.makeOverlay(end, end);
  return { start, endMarker };
}

function endOf(marker: number): number {
  return e8.overlayStart(marker) ?? e8.bufferSize();
}

/** Finds the next match from a position, stepping past empty matches where the last one ended. */
function findFrom(r: Replace, from: number, end: number, lastEnd: number | undefined) {
  let m = e8.search(r.from, { from, regexp: r.regexp, bound: end, caseFold: r.caseFold });
  if (m && m.start === m.end && m.start === lastEnd) {
    if (from + 1 > end) return undefined;
    m = e8.search(r.from, { from: from + 1, regexp: r.regexp, bound: end, caseFold: r.caseFold });
  }
  // As in Emacs, nothing is replaced once the search reaches the end.
  if (m && m.start === m.end && m.start >= end) return undefined;
  return m;
}

function replaceCurrent(r: Replace): number {
  const fixedCase = !(r.caseFold && e8.variable("case-replace") === true);
  const replaced = e8.replaceMatch(r.to, { literal: r.literal, fixedCase });
  r.count += 1;
  return replaced.end;
}

function occurrences(n: number): string {
  return `Replaced ${n} occurrence${n === 1 ? "" : "s"}`;
}

/** Replaces every match from `start` up to the end marker, returning how many. */
function replaceAll(r: Replace, start: number, endMarker: number): void {
  let pos = start;
  let lastEnd: number | undefined;
  for (;;) {
    const m = findFrom(r, pos, endOf(endMarker), lastEnd);
    if (m === undefined) break;
    pos = replaceCurrent(r);
    lastEnd = pos;
    if (m.start === m.end) {
      // Step past an empty match so the next search moves on.
      if (pos >= endOf(endMarker)) break;
    }
  }
  e8.gotoChar(pos);
}

function clearHighlights(r: Replace) {
  if (r.current !== undefined) e8.deleteOverlay(r.current);
  r.current = undefined;
  for (const id of r.others) e8.deleteOverlay(id);
  r.others = [];
}

function highlight(r: Replace, endMarker: number) {
  clearHighlights(r);
  if (r.match === undefined) return;
  r.current = e8.makeOverlay(r.match.start, r.match.end, { face: "query-replace", priority: 1001 });
  let pos = r.match.end;
  const end = endOf(endMarker);
  while (r.others.length < 200) {
    const m = e8.search(r.from, { from: pos, regexp: r.regexp, bound: end, caseFold: r.caseFold });
    if (m === undefined || m.end === m.start) break;
    r.others.push(e8.makeOverlay(m.start, m.end, { face: "lazy-highlight", priority: 1000 }));
    pos = m.end;
  }
}

let endMarker = -1;

/** Moves to the next match and asks about it, or finishes if there is none. */
function askNext(r: Replace) {
  const lastEnd = r.match === undefined ? undefined : r.next;
  const m = findFrom(r, r.next, endOf(endMarker), lastEnd);
  if (m === undefined) {
    finish(r);
    return;
  }
  r.match = { start: m.start, end: m.end };
  r.replaced = false;
  e8.gotoChar(m.end);
  highlight(r, endMarker);
  e8.message(`Query replacing ${r.shown} with ${r.to}: (? for help) `);
}

function finish(r: Replace) {
  clearHighlights(r);
  e8.deleteOverlay(endMarker);
  e8.setOverridingMap(null);
  replacing = undefined;
  e8.message(occurrences(r.count));
  if (r === waiting) {
    waiting = undefined;
    e8.call("exit-recursive-edit");
  }
}

/** The query-replace that queryReplace waits for, in a recursive edit. */
let waiting: Replace | undefined;

function start(from: string, to: string, regexp: boolean, query: boolean, options: { literal?: boolean; shown?: string; fromPoint?: boolean } = {}) {
  if (from === "") throw new Error("Empty search string");
  const caseFold = e8.foldCaseFor(from, true);
  const { start, endMarker: marker } = scope(options.fromPoint);
  e8.pushMark(start);
  const r: Replace = {
    from,
    to,
    regexp,
    literal: options.literal ?? !regexp,
    shown: options.shown ?? from,
    caseFold,
    replaced: false,
    next: start,
    count: 0,
    history: [],
    others: [],
  };
  if (!query) {
    replaceAll(r, start, marker);
    e8.deleteOverlay(marker);
    e8.message(occurrences(r.count));
    return;
  }
  endMarker = marker;
  replacing = r;
  e8.setOverridingMap("query-replace-map");
  askNext(r);
}

/**
 * Query-replaces from point to the end of the buffer and returns once it is
 * done, as query-replace does called from Lisp; `delimited` replaces only
 * whole words. ispell's R uses it.
 */
export function queryReplaceUntilDone(from: string, to: string, delimited = false): void {
  start(delimited ? `\\b${regexpQuote(from)}\\b` : from, to, delimited, true, {
    literal: true,
    shown: delimited ? `word ${from}` : from,
    fromPoint: true,
  });
  if (replacing === undefined) return;
  waiting = replacing;
  try {
    e8.recursiveEdit();
  } finally {
    if (waiting !== undefined) {
      waiting = undefined;
      if (replacing !== undefined) finish(replacing);
    }
  }
}

function asking(): Replace {
  if (replacing === undefined) throw new Error("Not replacing");
  return replacing;
}

/** Replaces the match being asked about; the search goes on after it. */
function replaceHere(r: Replace) {
  if (r.match === undefined || r.replaced) return;
  // The match data may have moved on while highlighting; find this match again.
  e8.search(r.from, { from: r.match.start, regexp: r.regexp, bound: r.match.end, caseFold: r.caseFold });
  r.history.push(r.match.start);
  r.next = replaceCurrent(r);
  r.match = { start: r.match.start, end: r.next };
}

e8.defineKeymap("query-replace-map");

const actions: [string[], string, string, (r: Replace) => void][] = [
  [["y", "SPC"], "query-replace-act", "Replace this match and go on to the next.", (r) => {
    replaceHere(r);
    askNext(r);
  }],
  [["n", "DEL", "<delete>"], "query-replace-skip", "Leave this match and go on to the next.", (r) => {
    if (r.match && !r.replaced) {
      r.history.push(r.match.start);
      r.next = r.match.end;
    }
    askNext(r);
  }],
  [["!"], "query-replace-automatic", "Replace this match and all the rest without asking.", (r) => {
    replaceHere(r);
    replaceAll(r, r.next, endMarker);
    finish(r);
  }],
  [["."], "query-replace-act-and-exit", "Replace this match and stop.", (r) => {
    replaceHere(r);
    finish(r);
  }],
  [[","], "query-replace-act-and-stay", "Replace this match and stay here; y or n then moves on.", (r) => {
    replaceHere(r);
    r.replaced = true;
    clearHighlights(r);
    e8.gotoChar(r.next);
    e8.message(`Query replacing ${r.shown} with ${r.to}: (? for help) `);
  }],
  [["^"], "query-replace-backup", "Go back to the last match asked about.", (r) => {
    const back = r.history.pop();
    if (back === undefined) {
      e8.message("No previous match");
      return;
    }
    r.next = back;
    r.match = undefined;
    askNext(r);
  }],
  [["q", "RET"], "query-replace-exit", "Stop replacing.", (r) => finish(r)],
  [["?", "C-h"], "query-replace-help", "Say what the keys do while query-replace asks.", (r) => {
    e8.message(
      "y or SPC: replace, n or DEL: skip, !: replace the rest, .: replace and stop, " +
        ",: replace and stay, ^: back, q or RET: stop",
    );
  }],
];

for (const [keys, name, doc, act] of actions) {
  const command = e8.defineCommand({ name, doc, run: () => act(asking()) });
  for (const key of keys) e8.bindKey(key, command, "query-replace-map");
}

const quit = e8.defineCommand({
  name: "query-replace-quit",
  doc: "Stop replacing, keeping what has been replaced.",
  run: () => {
    finish(asking());
    e8.message("Quit");
  },
});
e8.bindKey("C-g", quit, "query-replace-map");

const otherKey = e8.defineCommand({
  name: "query-replace-other-key",
  doc: "Stop replacing and run the key typed, as query-replace does for keys it does not know.",
  run: () => {
    const key = e8.lastKey();
    finish(asking());
    if (key !== undefined) e8.unreadKeys(key);
  },
});
e8.setKeymapDefault("query-replace-map", otherKey);

const queryReplace = e8.defineCommand({
  name: "query-replace",
  doc:
    "Replace a string with another, asking at each match.\n\n" +
    "At each match: y or SPC replaces it, n or DEL skips it, ! replaces the rest, . replaces it and stops, " +
    "q or RET stops. Case is ignored unless the string has a capital letter, and then replacements follow " +
    "the case of what they replace. Works from point to the end of the buffer, or on the region if it is active.",
  params: [
    { name: "from", prompt: "Query replace: ", history: "query-replace-history" },
    { name: "to", prompt: "Query replace with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, false, true),
});

const queryReplaceRegexp = e8.defineCommand({
  name: "query-replace-regexp",
  doc:
    "Replace matches of a regular expression, asking at each one.\n\n" +
    "In the replacement, \\& is the whole match and \\1 to \\9 its groups. See query-replace for the keys.",
  params: [
    { name: "regexp", prompt: "Query replace regexp: ", history: "query-replace-history" },
    { name: "to", prompt: "Query replace regexp with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, true, true),
});

e8.defineCommand({
  name: "replace-string",
  doc: "Replace every match of a string from point to the end of the buffer, or in the active region.",
  params: [
    { name: "from", prompt: "Replace string: ", history: "query-replace-history" },
    { name: "to", prompt: "Replace string with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, false, false),
});

e8.defineCommand({
  name: "replace-regexp",
  doc:
    "Replace every match of a regular expression from point to the end of the buffer, or in the active region.\n\n" +
    "In the replacement, \\& is the whole match and \\1 to \\9 its groups.",
  params: [
    { name: "regexp", prompt: "Replace regexp: ", history: "query-replace-history" },
    { name: "to", prompt: "Replace regexp with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, true, false),
});

e8.bindKey("M-%", queryReplace);
e8.bindKey("C-M-%", queryReplaceRegexp);

// Lines matching a regexp, after replace.el: keep-lines, flush-lines,
// kill-matching-lines, copy-matching-lines and how-many, from point to the
// end, or in the region when it is active.

/**
 * Whether a regexp search folds case, as these commands decide: with
 * case-fold-search and search-upper-case, only if the regexp has no
 * capital letter that is not after a backslash, as isearch-no-upper-case-p.
 */
function regexpFoldsCase(regexp: string): boolean {
  const on = (v: e8.Value | undefined) => v !== null && v !== undefined && v !== false;
  if (!on(e8.variable("case-fold-search"))) return false;
  if (!on(e8.variable("search-upper-case"))) return true;
  return !/(^|[^\\])(\\\\)*[A-Z]/u.test(regexp.replace(/\\[A-Za-z]/g, ""));
}

/** Reads the regexp for keep-lines and the rest, as keep-lines-read-args. */
const readLinesRegexp = (prompt: string) => e8.readString(`${prompt}: `, { history: "regexp-history" });

/**
 * The stretch these commands work on: the region if it is active, else
 * from point to the end; with `wholeLines`, the end goes back to the start
 * of its line, as keep-lines has it. Point goes to the start.
 */
function linesRange(wholeLines: boolean): [number, e8.Marker] {
  const mark = e8.mark();
  let [start, end] = e8.regionActive() && mark !== undefined ? [Math.min(mark, e8.point()), Math.max(mark, e8.point())] : [e8.point(), e8.pointMax()];
  if (wholeLines && e8.regionActive()) {
    const bol = e8.lineBeginningPosition(end);
    if (end !== bol && end !== e8.pointMax()) end = bol;
  }
  e8.gotoChar(start);
  return [start, e8.makeMarker(end)];
}

const forwardLineFrom = (pos: number): number => {
  const line = e8.lineOf(pos) + 1;
  return line >= e8.lineCount() ? e8.pointMax() : Math.min(e8.pointMax(), e8.lineStart(line));
};

e8.defineCommand({
  name: "keep-lines",
  doc: "Delete the lines after point, or in the region, that have no match for a regexp. A match across lines keeps them all.",
  run: async () => {
    if (e8.bufferReadOnly()) e8.signal("buffer-read-only", `Buffer is read-only: ${e8.bufferName()}`);
    const regexp = await readLinesRegexp("Keep lines containing match for regexp");
    const [, rend] = linesRange(true);
    const caseFold = regexpFoldsCase(regexp);
    e8.saveExcursion(() => {
      if (e8.point() !== e8.lineBeginningPosition()) e8.gotoChar(forwardLineFrom(e8.point()));
      let start = e8.point();
      while (e8.point() < e8.markerPosition(rend)!) {
        if (e8.reSearchForward(regexp, { bound: e8.markerPosition(rend)!, noerror: true, caseFold }) === undefined) {
          e8.deleteRegion(start, e8.markerPosition(rend)!);
          e8.gotoChar(e8.markerPosition(rend)!);
        } else {
          const end = e8.lineBeginningPosition(e8.matchBeginning(0)!);
          if (start < end) e8.deleteRegion(start, end);
        }
        start = forwardLineFrom(e8.point());
        if (e8.point() < e8.markerPosition(rend)! && e8.matchBeginning(0) === e8.matchEnd(0)) e8.gotoChar(e8.point() + 1);
      }
    });
    e8.deleteMarker(rend);
  },
});

/** Runs `act` on each line after point, or in the region, with a match for `regexp`, and says how many, as flush-lines and its kin. */
function matchingLines(regexp: string, act: (from: number, to: number, first: boolean) => void, verb: string): void {
  const [, rend] = linesRange(false);
  const caseFold = regexpFoldsCase(regexp);
  let count = 0;
  e8.saveExcursion(() => {
    while (e8.point() < e8.markerPosition(rend)! && e8.reSearchForward(regexp, { bound: e8.markerPosition(rend)!, noerror: true, caseFold }) !== undefined) {
      const from = e8.lineBeginningPosition(e8.matchBeginning(0)!);
      const to = forwardLineFrom(e8.point());
      e8.gotoChar(to);
      act(from, to, count === 0);
      count++;
    }
  });
  e8.deleteMarker(rend);
  e8.message(`${verb} ${count} matching line${count === 1 ? "" : "s"}`);
}

e8.defineCommand({
  name: "flush-lines",
  doc: "Delete the lines after point, or in the region, that have a match for a regexp.",
  run: async () => {
    if (e8.bufferReadOnly()) e8.signal("buffer-read-only", `Buffer is read-only: ${e8.bufferName()}`);
    const regexp = await readLinesRegexp("Flush lines containing match for regexp");
    matchingLines(regexp, (from, to) => e8.deleteRegion(from, to), "Deleted");
  },
});

e8.defineCommand({
  name: "kill-matching-lines",
  doc: "Kill the lines after point, or in the region, that have a match for a regexp, together as one kill.",
  run: async () => {
    if (e8.bufferReadOnly()) e8.signal("buffer-read-only", `Buffer is read-only: ${e8.bufferName()}`);
    const regexp = await readLinesRegexp("Kill lines containing match for regexp");
    matchingLines(regexp, (from, to, first) => {
      if (!first) e8.setLastCommand("kill-region");
      e8.killRegion(from, to);
    }, "Killed");
  },
});

e8.defineCommand({
  name: "copy-matching-lines",
  doc: "Copy the lines after point, or in the region, that have a match for a regexp to the kill ring, together as one kill.",
  run: async () => {
    const regexp = await readLinesRegexp("Copy lines containing match for regexp");
    matchingLines(regexp, (from, to, first) => {
      if (!first) e8.setLastCommand("kill-region");
      // As copy-region-as-kill, through M-w's command, the mark put back after.
      const mark = e8.mark();
      e8.setMark(from);
      e8.gotoChar(to);
      e8.call("kill-ring-save");
      if (mark !== undefined) e8.setMark(mark);
    }, "Copied");
  },
});

e8.defineCommand({
  name: "how-many",
  doc: "Say how many matches for a regexp there are after point, or in the region.",
  run: async () => {
    const regexp = await readLinesRegexp("How many matches for regexp");
    let count = 0;
    e8.saveExcursion(() => {
      const mark = e8.mark();
      const [start, end] = e8.regionActive() && mark !== undefined ? [Math.min(mark, e8.point()), Math.max(mark, e8.point())] : [e8.point(), e8.pointMax()];
      e8.gotoChar(start);
      const caseFold = regexpFoldsCase(regexp);
      while (e8.point() < end && e8.reSearchForward(regexp, { bound: end, noerror: true, caseFold }) !== undefined) {
        if (e8.matchBeginning(0) === e8.matchEnd(0) && e8.point() < e8.pointMax()) e8.gotoChar(e8.point() + 1);
        count++;
      }
    });
    e8.message(`${count} occurrence${count === 1 ? "" : "s"}`);
  },
});

for (const [alias, name] of [
  ["delete-non-matching-lines", "keep-lines"],
  ["delete-matching-lines", "flush-lines"],
  ["count-matches", "how-many"],
] as const) {
  e8.defalias(alias, name);
}

// occur, after replace.el: the lines of the buffer matching a regexp, listed
// in *Occur* with their line numbers, the matches highlighted; RET or a
// click goes to one, and next-error goes through them.

for (const [name, doc, value] of [
  ["list-matching-lines-face", "The face occur shows matches in.", "match"],
  ["list-matching-lines-buffer-name-face", "The face of occur's line naming the buffer.", "underline"],
  ["list-matching-lines-prefix-face", "The face of the line numbers occur shows.", "shadow"],
  ["occur-hook", "Functions run after occur makes *Occur*.", null],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value });
}

/** Where each line of an *Occur* buffer goes: the buffer, and markers at the start and end of each match on the line. */
const occurTargets = new Map<number, { buffer: string; matches: [e8.Marker, e8.Marker][] }>();
let nextOccurTarget = 0;

/** What occur was last asked, to make *Occur* again with g. */
let occurArgs: { regexp: string; buffer: string; region?: [number, number] } | undefined;

/** Lists the lines matching `regexp` in *Occur*, as occur-1 does for one buffer; returns how many matches there are. */
function occurIn(regexp: string, buffer: string, region?: [number, number]): number {
  const caseFold = e8.withCurrentBuffer(buffer, () => regexpFoldsCase(regexp));
  const lines: { line: number; text: string; spans: [number, number][]; target: number }[] = [];
  let matches = 0;
  e8.withCurrentBuffer(buffer, () =>
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        if (region !== undefined) e8.narrowToRegion(region[0], region[1]);
        e8.gotoChar(e8.pointMin());
        let lastLine = -1;
        while (e8.point() < e8.pointMax() && e8.reSearchForward(regexp, { noerror: true, caseFold }) !== undefined) {
          const [b, e] = [e8.matchBeginning(0)!, e8.matchEnd(0)!];
          const bol = e8.lineBeginningPosition(b);
          const eol = e8.lineEndPosition(b);
          const line = e8.saveRestriction(() => {
            e8.widen();
            return e8.lineOf(b) + 1;
          });
          // Every match on the line, highlighted, as occur-engine-line.
          const text = e8.bufferSubstringNoProperties(bol, eol);
          const spans: [number, number][] = [];
          let from = 0;
          while (from <= text.length) {
            const s = e8.stringMatch(regexp, text, { caseFold, start: from });
            if (s === undefined) break;
            const f = e8.matchEnd(0)!;
            if (f === s) {
              from = s + 1;
              continue;
            }
            spans.push([s, f]);
            from = f;
          }
          if (spans.length === 0) spans.push([b - bol, b - bol]);
          matches += spans.filter(([s, f]) => f > s).length || 1;
          if (line !== lastLine) {
            const id = nextOccurTarget++;
            occurTargets.set(id, { buffer, matches: spans.map(([s, f]) => [e8.makeMarker(bol + s), e8.makeMarker(bol + f)]) });
            lines.push({ line, text, spans, target: id });
            lastLine = line;
          }
          e8.gotoChar(Math.max(e, eol));
          if (e8.point() < e8.pointMax()) e8.gotoChar(e8.point() + 1);
        }
      }),
    ),
  );
  e8.getBufferCreate("*Occur*");
  e8.withCurrentBuffer("*Occur*", () => {
    if (e8.variable("major-mode") !== "occur-mode") e8.call("occur-mode");
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
      const header =
        `${matches} ${plural(matches, "match", "matches")}` +
        (lines.length === matches ? "" : ` in ${lines.length} ${plural(lines.length, "line", "lines")}`) +
        ` for "${regexp}" in buffer: ${buffer}` +
        (region === undefined ? "" : ` within region: ${region[0] + 1}-${region[1] + 1}`);
      e8.insert(e8.propertize(header, { face: String(e8.variable("list-matching-lines-buffer-name-face") ?? "underline"), "read-only": true }));
      e8.insert("\n");
      for (const { line, text, spans, target } of lines) {
        const start = e8.point();
        e8.insert(e8.propertize(String(line).padStart(7) + ":", { face: String(e8.variable("list-matching-lines-prefix-face") ?? "shadow"), "occur-prefix": true, "read-only": true }));
        // The line, its matches in list-matching-lines-face.
        const face = String(e8.variable("list-matching-lines-face") ?? "match");
        let at = 0;
        for (const [b, f] of spans) {
          if (f <= b) continue;
          e8.insert(text.slice(at, b));
          e8.insert(e8.propertize(text.slice(b, f), { face }));
          at = f;
        }
        e8.insert(text.slice(at));
        e8.putTextProperty(start, e8.point(), "occur-target", target);
        e8.putTextProperty(start, e8.point(), "mouse-face", "highlight");
        e8.insert("\n");
      }
    });
    e8.gotoChar(e8.pointMin());
    e8.setBufferModified(false);
  });
  return matches;
}

/** Makes *Occur* for a regexp in a buffer, shows it and says how many matches, as occur. */
function runOccur(regexp: string, buffer: string, region?: [number, number]): void {
  occurArgs = { regexp, buffer, region };
  const count = occurIn(regexp, buffer, region);
  e8.message(`Searched 1 buffer; ${count === 0 ? "no" : String(count)} ${count === 1 ? "match" : "matches"} for "${regexp}"`);
  if (count === 0) {
    e8.call("kill-buffer", "*Occur*");
    return;
  }
  e8.call("display-buffer", "*Occur*");
  e8.setVariable("next-error-last-buffer", e8.getBuffer("*Occur*") ?? null);
  e8.withCurrentBuffer("*Occur*", () => e8.runHooks("occur-hook"));
}

e8.defineVariable({ name: "regexp-history", doc: "Regexps answered at prompts that ask for one, newest first.", value: [] });

e8.defineCommand({
  name: "occur",
  doc:
    "List the lines of the buffer, or of the region if it is active, that match a regexp, in *Occur*.\n\n" +
    "There RET goes to a line's match, C-o shows it, n and p go through them, and M-g n does from anywhere.",
  run: async () => {
    const history = e8.variable("regexp-history");
    const def = Array.isArray(history) && typeof history[0] === "string" ? history[0] : undefined;
    const answer = await e8.readString(def === undefined ? "List lines matching regexp: " : `List lines matching regexp (default ${def}): `, {
      history: "regexp-history",
    });
    const regexp = answer === "" && def !== undefined ? def : answer;
    if (regexp === "") e8.userError("Empty regexp");
    const mark = e8.mark();
    const region: [number, number] | undefined =
      e8.regionActive() && mark !== undefined ? [Math.min(mark, e8.point()), Math.max(mark, e8.point())] : undefined;
    runOccur(regexp, e8.bufferName(), region);
  },
});
e8.bindKey("M-s o", "occur");

/** The *Occur* line's target at point, or an error, as occur-mode--find-occurrences. */
function occurTargetAt(pos: number): { buffer: string; matches: [e8.Marker, e8.Marker][] } {
  const id = e8.getTextProperty(pos, "occur-target");
  const target = typeof id === "number" ? occurTargets.get(id) : undefined;
  if (target === undefined) throw new Error("No occurrence on this line");
  if (!e8.getBuffer(target.buffer)) throw new Error("Buffer for this occurrence was killed");
  return target;
}

/** Goes to the occurrence on this *Occur* line, in another window with `other`, or only shows it with `display`. */
function gotoOccurrence(how: "pop" | "other" | "display"): void {
  const target = occurTargetAt(e8.point());
  const pos = e8.markerPosition(target.matches[0]![0])!;
  if (how === "display") {
    const occur = e8.selectedWindow();
    e8.call("display-buffer", target.buffer);
    const window = e8.windowList().find((w) => e8.windowBuffer(w) === target.buffer);
    if (window !== undefined) {
      e8.selectWindow(window);
      e8.gotoChar(pos);
      e8.selectWindow(occur);
    }
    return;
  }
  e8.call(how === "other" ? "switch-to-buffer-other-window" : "pop-to-buffer", target.buffer);
  e8.gotoChar(pos);
}

e8.defineCommand({ name: "occur-mode-goto-occurrence", doc: "Go to the occurrence on this line.", run: () => gotoOccurrence("pop") });
e8.defineCommand({ name: "occur-mode-goto-occurrence-other-window", doc: "Go to the occurrence on this line, in another window.", run: () => gotoOccurrence("other") });
e8.defineCommand({ name: "occur-mode-display-occurrence", doc: "Show the occurrence on this line in another window, staying in *Occur*.", run: () => gotoOccurrence("display") });

/** Moves to the `n`th next line with an occurrence, back if negative, as occur-find-match. */
function occurFindMatch(n: number, message: string): void {
  for (let i = 0; i < Math.abs(n); i++) {
    const line = e8.lineOf(e8.point());
    let l = line + (n > 0 ? 1 : -1);
    while (l >= 0 && l < e8.lineCount() && e8.getTextProperty(e8.lineStart(l), "occur-target") === undefined) l += n > 0 ? 1 : -1;
    if (l < 0 || l >= e8.lineCount() || e8.getTextProperty(e8.lineStart(l), "occur-target") === undefined) throw new Error(message);
    e8.gotoChar(e8.lineStart(l) + 8);
  }
}

e8.defineCommand({
  name: "occur-next",
  doc: "Move to the next occurrence in *Occur*; with a prefix argument, that many.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => occurFindMatch(n, "No more matches"),
});
e8.defineCommand({
  name: "occur-prev",
  doc: "Move to the occurrence before in *Occur*; with a prefix argument, that many back.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => occurFindMatch(-n, "No earlier matches"),
});

e8.defun("occur-next-error", (n: number, reset: boolean) => {
  if (reset) e8.gotoChar(e8.pointMin());
  else if (n < 0) e8.gotoChar(e8.lineBeginningPosition());
  else if (n > 0) e8.gotoChar(e8.lineEndPosition());
  occurFindMatch(n === 0 ? 1 : n, "No more matches");
  const occur = e8.bufferName();
  const p = e8.point();
  // In case *Occur* shows in a window that is not selected.
  const window = e8.windowList().find((w) => e8.windowBuffer(w) === occur);
  if (window !== undefined) {
    const selected = e8.selectedWindow();
    e8.selectWindow(window);
    e8.gotoChar(p);
    e8.selectWindow(selected);
  }
  e8.withCurrentBuffer(occur, () => e8.gotoChar(p));
  const target = e8.withCurrentBuffer(occur, () => occurTargetAt(p));
  e8.call("pop-to-buffer", target.buffer);
  e8.gotoChar(e8.markerPosition(target.matches[0]![0])!);
});

e8.defineCommand({
  name: "occur-revert-buffer",
  doc: "Make *Occur* again, for the same regexp in the same buffer.",
  run: () => {
    if (occurArgs !== undefined) runOccur(occurArgs.regexp, occurArgs.buffer, occurArgs.region);
  },
});

e8.defineMajorMode({
  name: "occur-mode",
  modeName: "Occur",
  doc: "The mode of *Occur*: the lines matching a regexp. RET goes to one, o in another window, C-o shows it, n and p and M-n and M-p move, g lists them again.",
  bindings: {
    RET: "occur-mode-goto-occurrence",
    "C-c C-c": "occur-mode-goto-occurrence",
    o: "occur-mode-goto-occurrence-other-window",
    "C-o": "occur-mode-display-occurrence",
    n: "next-error-no-select",
    p: "previous-error-no-select",
    "M-n": "occur-next",
    "M-p": "occur-prev",
    g: "occur-revert-buffer",
    q: "quit-window",
  } as Record<string, e8.CommandName>,
  setup: () => {
    e8.setVariable("next-error-function", "occur-next-error");
    e8.setReadOnly(true);
  },
});
