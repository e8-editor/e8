// Dynamic abbreviations, after Emacs's dabbrev.el: M-/ expands the word
// before point to the nearest word before it that starts the same way,
// then after it, then in other buffers; M-/ again tries the next one.

import { regexpQuote, truthy } from "subr";

for (const [name, doc, value] of [
  ["dabbrev-backward-only", "Whether M-/ looks only before point.", false],
  ["dabbrev-case-fold-search", "Whether M-/ matches words of another case: case-fold-search to follow it, or t or nil.", "case-fold-search"],
  ["dabbrev-upcase-means-case-search", "Whether an abbreviation with capitals matches only the same case.", false],
  ["dabbrev-case-distinction", "Whether words differing only in case are different expansions: case-replace to follow it, or t or nil.", "case-replace"],
  ["dabbrev-case-replace", "Whether an expansion takes the case of the abbreviation: case-replace to follow it, or t or nil.", "case-replace"],
  ["dabbrev-abbrev-char-regexp", "The regexp for a character of an abbreviation, or nil for word and symbol characters.", null],
  ["dabbrev-eliminate-newlines", "Whether runs of spaces and newlines in an expansion become one space.", true],
  ["dabbrev-check-other-buffers", "Whether M-/ looks in other buffers of the same major mode once the current one has none.", true],
  ["dabbrev-check-all-buffers", "Whether M-/ then looks in all other buffers.", true],
  ["dabbrev-ignored-buffer-names", "Buffers M-/ never looks in.", ["*Messages*", "*Buffer List*"]],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value });
}

/** A variable's value, where `follow` names the variable to take it from, as dabbrev's case options do. */
function option(name: string, follow: string): boolean {
  const v = e8.variable(name);
  return v === follow ? truthy(e8.variable(follow)) : truthy(v);
}

/** What M-/ remembers between tries, as dabbrev's dabbrev--last- variables. */
interface State {
  abbrev: string;
  /** The expansions found so far, as compared, to skip them again. */
  table: string[];
  /** Where the abbreviation ends, in the buffer expanded in. */
  abbrevLocation: e8.Marker;
  expansion: string;
  /** Where the search goes on from in the buffer searched, or undefined to start from point. */
  expansionLocation: number | undefined;
  /** 1 back, -1 forward, 0 both. */
  direction: number;
  /** The buffer searched last, other than the current one. */
  buffer: string | undefined;
  /** Buffers still to search, nearest first. */
  friends: string[] | undefined;
  casePattern: "upcase" | "downcase" | undefined;
  /** The other buffer the last expansion came from, said once when it changes. */
  found: string | undefined;
}

let last: State | undefined;

const charRegexp = (): string => {
  const own = e8.variable("dabbrev-abbrev-char-regexp");
  return typeof own === "string" ? own : "\\sw\\|\\s_";
};

/** Whether an abbreviation matches words of other cases, as dabbrev--ignore-case-p. */
const ignoreCaseP = (abbrev: string): boolean =>
  option("dabbrev-case-fold-search", "case-fold-search") &&
  (!truthy(e8.variable("dabbrev-upcase-means-case-search")) || abbrev === abbrev.toLowerCase());

/** Moves back over abbreviation characters, as dabbrev--goto-start-of-abbrev. */
function gotoStartOfAbbrev(): void {
  const re = charRegexp();
  const min = e8.minibufferPromptEnd();
  if (e8.point() <= min) return;
  e8.gotoChar(e8.point() - 1);
  while (e8.lookingAt(re) && e8.point() > min && e8.point() !== e8.fieldBeginning(e8.point(), false, e8.point() - 1)) {
    e8.gotoChar(e8.point() - 1);
  }
  if (!e8.lookingAt(re)) e8.gotoChar(e8.point() + 1);
}

/** The abbreviation before point, after any punctuation typed after it, as dabbrev--abbrev-at-point. */
function abbrevAtPoint(): [string, number] {
  if (e8.point() === e8.pointMin()) e8.userError("No possible abbreviation preceding point");
  return e8.saveExcursion(() => {
    const end = e8.point();
    const re = charRegexp();
    if (!e8.lookingAt(re, e8.point() - 1)) {
      if (e8.reSearchBackward(re, { noerror: true }) === undefined) e8.userError("No possible abbreviation preceding point");
      e8.gotoChar(e8.point() + 1);
    }
    gotoStartOfAbbrev();
    return [e8.bufferSubstringNoProperties(e8.point(), end), end];
  });
}

/**
 * The next expansion of `abbrev` from where the search stands, back or
 * forward, not one found before, as dabbrev--search. Leaves point at its start.
 */
function search(s: State, abbrev: string, reverse: boolean, ignoreCase: boolean): string | undefined {
  const re = charRegexp();
  const pattern1 = `${regexpQuote(abbrev)}\\(${re}\\)`;
  const pattern2 = `${regexpQuote(abbrev)}\\(\\(${re}\\)+\\)`;
  for (;;) {
    const found = reverse
      ? e8.reSearchBackward(pattern1, { noerror: true, caseFold: ignoreCase })
      : e8.reSearchForward(pattern1, { noerror: true, caseFold: ignoreCase });
    if (found === undefined) return undefined;
    const matchStart = e8.matchBeginning(0)!;
    e8.gotoChar(matchStart);
    // A match inside a word counts only from the word's start.
    gotoStartOfAbbrev();
    let result: string | undefined;
    let resume: number;
    if (e8.lookingAt(pattern1, undefined, { caseFold: ignoreCase })) {
      e8.reSearchForward(pattern2, { caseFold: ignoreCase });
      result = e8.matchString(0)!;
      const compared = ignoreCase && option("dabbrev-case-distinction", "case-replace") ? result.toLowerCase() : result;
      if (s.table.includes(compared)) result = undefined;
      else s.table.push(compared);
      resume = reverse ? e8.matchBeginning(0)! : e8.matchEnd(0)!;
    } else {
      resume = reverse ? matchStart : e8.matchEnd(0) ?? matchStart + 1;
    }
    e8.gotoChar(resume);
    if (result !== undefined) {
      e8.gotoChar(e8.matchBeginning(0)!);
      return result;
    }
  }
}

/** Tries `n` times to find an expansion in the current buffer, from where the search stands, as dabbrev--try-find. */
function tryFind(s: State, abbrev: string, reverse: boolean, n: number, ignoreCase: boolean): string | undefined {
  return e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      if (s.expansionLocation !== undefined) e8.gotoChar(s.expansionLocation);
      let expansion: string | undefined;
      for (let count = n; count > 0; count--) {
        expansion = search(s, abbrev, reverse, ignoreCase);
        if (expansion === undefined) break;
      }
      if (expansion !== undefined) s.expansionLocation = e8.point();
      return expansion;
    }),
  );
}

/** The other buffers to look in, those in windows first, then the same mode's, then the rest, as dabbrev--make-friend-buffer-list. */
function friendBuffers(): string[] {
  if (!truthy(e8.variable("dabbrev-check-other-buffers"))) return [];
  const here = e8.bufferName();
  const ignored = (e8.variable("dabbrev-ignored-buffer-names") ?? []) as string[];
  const mode = e8.variable("major-mode");
  const others = e8.bufferList().filter((b) => b !== here && !ignored.includes(b));
  const same = others.filter((b) => e8.bufferLocalValue("major-mode", b) === mode);
  let list = same;
  if (truthy(e8.variable("dabbrev-check-all-buffers"))) list = [...same, ...others.filter((b) => !same.includes(b))];
  for (const w of e8.windowList().slice().reverse()) {
    const b = e8.windowBuffer(w);
    if (b !== undefined && w !== e8.selectedWindow() && list.includes(b)) list = [b, ...list.filter((x) => x !== b)];
  }
  return list;
}

/** The next expansion, back then forward then in other buffers, as dabbrev--find-expansion. */
function findExpansion(s: State, abbrev: string, direction: number, ignoreCase: boolean): string | undefined {
  const inBuffer = (f: () => string | undefined) => (s.buffer !== undefined && e8.getBuffer(s.buffer) ? e8.withCurrentBuffer(s.buffer, f) : f());
  const back = inBuffer(() => {
    if (direction < 0) return undefined;
    s.direction = Math.min(1, direction);
    return tryFind(s, abbrev, true, Math.max(1, direction), ignoreCase);
  });
  if (back !== undefined) return back;
  const forward = inBuffer(() => {
    if (direction > 0) return undefined;
    s.direction = -1;
    return tryFind(s, abbrev, false, Math.max(1, -direction), ignoreCase);
  });
  if (forward !== undefined) return forward;
  s.direction = -1;
  if (s.buffer === undefined) s.friends ??= friendBuffers();
  while (s.friends !== undefined && s.friends.length > 0) {
    s.buffer = s.friends.shift()!;
    if (!e8.getBuffer(s.buffer)) continue;
    s.expansionLocation = 0;
    const found = e8.withCurrentBuffer(s.buffer, () => {
      s.expansionLocation = e8.pointMin();
      return tryFind(s, abbrev, false, 1, ignoreCase);
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Puts `expansion` in place of `old`, or after the abbreviation, with the case the options call for, as dabbrev--substitute-expansion. */
function substitute(s: State, old: string | undefined, abbrev: string, expansionIn: string, recordCasePattern: boolean): string {
  let expansion = expansionIn;
  let useCaseReplace = ignoreCaseP(abbrev) && option("dabbrev-case-replace", "case-replace");
  if (abbrev === " ") {
    if (s.casePattern === "upcase") expansion = expansion.toUpperCase();
    else if (s.casePattern === "downcase") expansion = expansion.toLowerCase();
    useCaseReplace = false;
  }
  const rest = expansion.slice(1);
  const firstLetter = abbrev.search(/\p{L}/u);
  if (
    firstLetter < 0 ||
    (!(
      (rest === rest.toLowerCase() || rest === rest.toUpperCase()) &&
      (abbrev === abbrev.toLowerCase() || (abbrev === abbrev.toUpperCase() && abbrev.length - firstLetter > 1))
    ) &&
      abbrev === expansion.slice(0, abbrev.length))
  ) {
    useCaseReplace = false;
  }
  if (expansion === expansion.toLowerCase() && abbrev === abbrev.toLowerCase()) useCaseReplace = false;
  if (useCaseReplace) expansion = expansion.toLowerCase();
  if (recordCasePattern) {
    s.casePattern = useCaseReplace ? (abbrev === abbrev.toUpperCase() ? "upcase" : abbrev === abbrev.toLowerCase() ? "downcase" : undefined) : undefined;
  }
  if (truthy(e8.variable("dabbrev-eliminate-newlines"))) {
    const from = abbrev === " " ? 0 : abbrev.length;
    expansion = expansion.slice(0, from) + expansion.slice(from).replace(/[\n \t]+/g, " ");
  }
  if (old !== undefined) {
    e8.saveExcursion(() => e8.search(old, { backward: true, caseFold: false }));
  } else {
    // The abbreviation just before point, as search-backward then search-forward find it.
    const m = e8.search(abbrev, { backward: true, caseFold: false });
    e8.search(abbrev, { from: m?.start, caseFold: false });
  }
  e8.replaceMatch(expansion, { fixedCase: !useCaseReplace, literal: true });
  return expansion;
}

e8.defineCommand({
  name: "dabbrev-expand",
  barfIfReadOnly: true,
  doc:
    "Expand the word before point to the nearest word before it that starts with it, else one after it, else one " +
    "in another buffer. Again, try the next one.\n\nA positive prefix argument takes the Nth distinct word back; " +
    "a negative one looks forward. After an expansion and a space, M-/ copies the word that followed the expansion.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    const continuing =
      arg === null &&
      last !== undefined &&
      e8.markerPosition(last.abbrevLocation) !== undefined &&
      e8.lastCommand() === "dabbrev-expand";
    let s: State;
    let abbrev: string;
    let old: string | undefined;
    let expansion: string | undefined;
    let recordCasePattern = false;
    if (continuing) {
      s = last!;
      abbrev = s.abbrev;
      old = s.expansion;
    } else if (
      e8.point() > e8.pointMin() &&
      e8.charAfter(e8.point() - 1) === " " &&
      last !== undefined &&
      e8.markerPosition(last.abbrevLocation) === e8.point() - 1
    ) {
      // A space after an expansion: copy the word that followed it.
      s = last;
      abbrev = " ";
      const inBuffer = <T,>(f: () => T): T => (s.buffer !== undefined && e8.getBuffer(s.buffer) ? e8.withCurrentBuffer(s.buffer, f) : f());
      expansion = inBuffer(() =>
        e8.saveExcursion(() =>
          e8.saveRestriction(() => {
            e8.widen();
            let at = s.expansionLocation ?? e8.point();
            if (s.direction === 1 || (s.direction === 0 && at < e8.point())) at += s.expansion.length;
            e8.gotoChar(at);
            e8.reSearchForward(`\\(?:${charRegexp()}\\)+`);
            const text = e8.bufferSubstringNoProperties(at, e8.point());
            s.expansionLocation = e8.point();
            return text;
          }),
        ),
      );
      s.direction = -1;
    } else {
      const [a, end] = abbrevAtPoint();
      abbrev = a;
      // A new expansion: the last one's marker is no longer needed.
      if (last !== undefined) e8.deleteMarker(last.abbrevLocation);
      last = undefined;
      s = {
        abbrev,
        table: [],
        abbrevLocation: e8.makeMarker(end),
        expansion: "",
        expansionLocation: undefined,
        direction: 0,
        buffer: undefined,
        friends: undefined,
        casePattern: undefined,
        found: undefined,
      };
      s.direction = arg === null ? (truthy(e8.variable("dabbrev-backward-only")) ? 1 : 0) : e8.prefixNumericValue(arg);
      recordCasePattern = true;
    }
    expansion ??= e8.saveExcursion(() => findExpansion(s, abbrev, s.direction, ignoreCaseP(abbrev)));
    if (expansion === undefined) {
      e8.deleteMarker(s.abbrevLocation);
      last = undefined;
      if (old !== undefined) {
        // Put back the abbreviation as it was typed.
        e8.saveExcursion(() => {
          const m = e8.search(old!, { backward: true, caseFold: false });
          if (m !== undefined) {
            e8.gotoChar(m.start);
            e8.insert(abbrev);
            e8.deleteRegion(e8.point(), e8.point() + old!.length);
          }
        });
      }
      e8.userError(`No${old !== undefined ? " further" : ""} dynamic expansion for ‘${abbrev}’ found`);
    }
    if (s.buffer !== s.found) {
      if (s.buffer !== undefined) e8.message(`Expansion found in ‘${s.buffer}’`);
      s.found = s.buffer;
    }
    s.expansion = substitute(s, old, abbrev, expansion!, recordCasePattern);
    s.abbrev = abbrev;
    e8.setMarker(s.abbrevLocation, e8.point());
    last = s;
  },
});
e8.bindKey("M-/", "dabbrev-expand");
