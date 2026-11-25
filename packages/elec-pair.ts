// Electric Pair mode, after Emacs's elec-pair.el: typing an open paren or
// a quote inserts its closing one too, typing the closing one where it
// already is moves over it, DEL between an empty pair deletes both, and
// RET between them opens a line. With the region active, typing a paren or
// quote wraps the region. It keeps the buffer's parens balanced, as
// electric-pair-preserve-balance says: it does not pair where that would
// leave one unmatched, nor skip where that would.

import { truthy } from "subr";

e8.defineVariable({
  name: "electric-pair-pairs",
  doc: "Pairs of characters Electric Pair mode pairs even where the syntax table gives them no paren or quote syntax, as [open, close] lists.",
  value: [["\"", "\""], ["‘", "’"], ["“", "”"]],
});
e8.defineVariable({
  name: "electric-pair-text-pairs",
  doc: "Pairs Electric Pair mode pairs in comments and strings, as well as electric-pair-pairs.",
  value: [["\"", "\""], ["‘", "’"], ["“", "”"]],
});
e8.defineVariable({
  name: "electric-pair-preserve-balance",
  doc: "Whether Electric Pair mode pairs and skips only where that keeps the buffer's parens and quotes balanced.",
  value: true,
});
e8.defineVariable({
  name: "electric-pair-delete-adjacent-pairs",
  doc: "Whether DEL between an open and close pair deletes both.",
  value: true,
});
e8.defineVariable({
  name: "electric-pair-open-newline-between-pairs",
  doc: "Whether RET between an open and close pair puts the close on a line of its own too.",
  value: true,
});
e8.defineVariable({
  name: "electric-pair-skip-whitespace",
  doc: "Whether typing a close paren moves over whitespace to one already there; chomp deletes the whitespace too.",
  value: true,
});

const charAt = (p: number): string => e8.charAfter(p) ?? "";
const charBefore = (p: number): string => e8.charBefore(p) ?? "";
const pairs = (name: string): [string, string][] => {
  const v = e8.variable(name);
  return Array.isArray(v) ? v.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2).map((p) => [String(p[0]), String(p[1])]) : [];
};
type ScanError = Error & { symbol: "scan-error"; data: [string, number, number] };
const isScanError = (e: unknown): e is ScanError => e instanceof Error && (e as { symbol?: string }).symbol === "scan-error";
/** The second position a scan error names, as (nth 3 err), from 0. */
const scanEnd = (e: ScanError): number => e.data[2] - 1;

/** The typed character, as last-command-event. */
function lastEvent(): string | undefined {
  const key = e8.lastKey();
  if (key === undefined) return undefined;
  if (key === "RET" || key === "C-j") return "\n";
  if (key === "SPC") return " ";
  if (key === "TAB") return "\t";
  return [...key].length === 1 ? key : undefined;
}

/** The syntax table for comments and strings, as electric-pair-text-syntax-table. */
const TEXT_TABLE = "prog-mode-syntax-table";

/** Runs `fn` with the text syntax table if in a string or comment, as electric-pair--with-syntax. */
function withSyntax<T>(stringOrComment: unknown, fn: () => T): T {
  if (!truthy(stringOrComment as e8.Value)) return fn();
  const table = e8.syntaxTable();
  e8.setSyntaxTable(TEXT_TABLE);
  try {
    return fn();
  } finally {
    e8.setSyntaxTable(table);
  }
}

type SyntaxInfo = { syntax: string; pair: string; unconditional: boolean; stringOrComment: number | true | null };

/** What a character is to Electric Pair mode here, as electric-pair-syntax-info. */
function syntaxInfo(ev: string): SyntaxInfo | undefined {
  const p = e8.point();
  const pre: number | true | null = p <= e8.pointMin() ? true : e8.syntaxPpss(p - 1).start;
  const post = e8.syntaxPpss(p).start;
  const soc = post !== null && pre !== null ? pre : null;
  const [syntax, pair] = withSyntax(soc, () => [e8.charSyntax(ev), e8.matchingParen(ev) ?? ev]);
  const fallback = soc !== null ? [...pairs("electric-pair-text-pairs"), ...pairs("electric-pair-pairs")] : pairs("electric-pair-pairs");
  const direct = fallback.find(([open]) => open === ev);
  const reverse = fallback.find(([, close]) => close === ev);
  if (["\"", "(", ")", "$"].includes(syntax)) return { syntax, pair, unconditional: false, stringOrComment: soc };
  if (direct) {
    return direct[0] === direct[1]
      ? { syntax: "\"", pair: ev, unconditional: true, stringOrComment: soc }
      : { syntax: "(", pair: direct[1], unconditional: true, stringOrComment: soc };
  }
  if (reverse) return { syntax: ")", pair: reverse[0], unconditional: true, stringOrComment: soc };
  return undefined;
}

/** syntax-ppss, parsing a string's or comment's text with the text syntax table, as electric-pair--syntax-ppss. */
function pairSyntaxPpss(pos = e8.point(), where: ("string" | "comment")[] = ["string", "comment"]): e8.ParseState {
  const quick = e8.syntaxPpss(pos);
  let start: number | undefined;
  if (quick.inString !== null && where.includes("string")) {
    start = quick.start! + 1;
  } else if (quick.inComment !== null && where.includes("comment")) {
    const p = e8.point();
    e8.gotoChar(quick.start!);
    e8.forwardComment(-e8.pointMax());
    e8.skipSyntaxForward(" >!");
    start = e8.point();
    e8.gotoChar(p);
  }
  if (start === undefined) return quick;
  return withSyntax(start, () => e8.parsePartialSexp(start!, pos));
}

type Pairing = [boolean, string?];

/**
 * How the lists around point stand, as electric-pair--balance-info: for
 * the innermost and the outermost, whether it is matched and its paren.
 */
function balanceInfo(direction: number, stringOrComment: number | true | null): [Pairing, Pairing] {
  let innermost: Pairing | undefined;
  let outermost: Pairing | undefined;
  const topLevel = () => {
    outermost = [true];
    innermost ??= [true];
  };
  const endedPrematurely = () => {
    const pos = e8.point();
    let matched: boolean;
    if (direction < 0) {
      try {
        const after = withSyntax(stringOrComment, () => e8.scanSexps(e8.point(), 1));
        matched = after !== null && charAt(pos) === withSyntax(stringOrComment, () => e8.matchingParen(charBefore(after)));
      } catch (e) {
        if (!isScanError(e)) throw e;
        matched = false;
      }
    } else {
      const ppss = pairSyntaxPpss(e8.point() - 1);
      const start = ppss.openParens[ppss.openParens.length - 1];
      const opener = start === undefined ? "" : charAt(start);
      matched = start !== undefined && charBefore(pos) === (withSyntax(stringOrComment, () => e8.matchingParen(opener)) ?? opener);
    }
    const actual = direction > 0 ? charBefore(e8.point()) : charAt(e8.point());
    innermost ??= [matched, actual];
    if (!matched) outermost = [matched, actual];
  };
  const p = e8.point();
  try {
    while (outermost === undefined) {
      try {
        withSyntax(stringOrComment, () => e8.scanSexps(e8.point(), direction > 0 ? e8.pointMax() : -e8.pointMax()));
        topLevel();
      } catch (e) {
        if (!isScanError(e)) throw e;
        if (!e.data[0].includes("ends prematurely") || (stringOrComment !== null && e8.syntaxPpss().start === null)) {
          topLevel();
        } else {
          e8.gotoChar(scanEnd(e));
          endedPrematurely();
        }
      }
    }
  } finally {
    e8.gotoChar(p);
  }
  return [innermost!, outermost!];
}

/** Whether there are strings started by `ch` left open, as electric-pair--unbalanced-strings-p. */
function unbalancedStrings(ch: string): boolean {
  const selector = e8.syntaxPpss();
  let relevant: e8.ParseState;
  if (selector.inComment !== null) {
    const p = e8.point();
    e8.gotoChar(selector.start!);
    e8.forwardComment(e8.pointMax());
    e8.skipSyntaxBackward(" >!");
    const end = e8.point();
    e8.gotoChar(p);
    relevant = pairSyntaxPpss(end);
  } else {
    relevant = e8.syntaxPpss(e8.pointMax());
  }
  return relevant.inString === "|" || relevant.inString === ch;
}

/** Whether pairing `ch` would unbalance the buffer, as electric-pair-inhibit-if-helps-balance. */
function inhibitIfHelpsBalance(ch: string): boolean {
  const info = syntaxInfo(ch);
  if (info === undefined) return false;
  const group = e8.prepareChangeGroup();
  try {
    e8.deleteRegion(e8.point() - 1, e8.point());
    if (info.syntax === "(") {
      const [, outermost] = balanceInfo(1, info.stringOrComment);
      return outermost[0] ? false : outermost[1] === info.pair;
    }
    if (info.syntax === "\"") return unbalancedStrings(ch);
    return false;
  } finally {
    e8.cancelChangeGroup(group);
  }
}

/** Whether point is in a string started by `ch`, as electric-pair--inside-string-p. */
const insideString = (ch: string): boolean => {
  const s = pairSyntaxPpss(e8.point(), ["comment"]).inString;
  return s === "|" || s === ch;
};

/** Whether skipping over `ch` keeps the balance, as electric-pair-skip-if-helps-balance. */
function skipIfHelpsBalance(ch: string): boolean {
  const info = syntaxInfo(ch);
  if (info === undefined) return false;
  const group = e8.prepareChangeGroup();
  try {
    e8.deleteRegion(e8.point() - 1, e8.point());
    if (info.syntax === ")") {
      const [innermost, outermost] = balanceInfo(-1, info.stringOrComment);
      if (outermost[0]) return innermost[0];
      if (innermost[0]) return outermost[1] !== info.pair;
      return false;
    }
    if (info.syntax === "\"") return insideString(ch);
    return false;
  } finally {
    e8.cancelChangeGroup(group);
  }
}

const preserving = (): boolean => truthy(e8.variable("electric-pair-preserve-balance"));

/** Whether to move over a typed close instead of inserting it, as electric-pair-default-skip-self. */
const skipSelf = (ch: string): boolean => (preserving() ? skipIfHelpsBalance(ch) : true);

/** Whether not to pair a typed open, as electric-pair-default-inhibit. */
function inhibit(ch: string): boolean {
  if (preserving()) return inhibitIfHelpsBalance(ch);
  // As electric-pair-conservative-inhibit.
  const p = e8.point();
  return charAt(p) === ch || (charBefore(p) === ch && charBefore(p - 1) === ch) || e8.charSyntax(charAt(p)) === "w";
}

/** Inserts a character as Electric Pair mode does, without pairing it again. */
function insertPairChar(ch: string): void {
  e8.insertAndInherit(ch);
}

/** Where the character just typed ends, as electric--after-char-pos, or undefined. */
function afterCharPos(ev: string): number | undefined {
  let p = e8.point();
  if (charBefore(p) === ev) return p;
  while (p > e8.pointMin() && " \t".includes(charBefore(p))) p--;
  if (charBefore(p) === ev) return p;
  while (p > e8.pointMin() && " \n\t".includes(charBefore(p))) p--;
  return charBefore(p) === ev ? p : undefined;
}

/** Moves over whitespace, unless that leaves a string or comment, as electric-pair--skip-whitespace. */
function skipWhitespace(): void {
  const saved = e8.point();
  const start = e8.syntaxPpss().start;
  let p = saved;
  while (p < e8.pointMax() && " \t\n".includes(charAt(p))) p++;
  e8.gotoChar(p);
  if (e8.syntaxPpss().start !== start) e8.gotoChar(saved);
}

const regionUsed = (): boolean => e8.regionActive() && e8.mark() !== undefined && e8.mark() !== e8.point();

/** What Electric Pair mode does after a character is typed, as electric-pair-post-self-insert-function. */
function postSelfInsert(): void {
  if (e8.variable("electric-pair-mode") !== true) return;
  const ev = lastEvent();
  if (ev === undefined) return;
  const pos = afterCharPos(ev);
  const info = syntaxInfo(ev);
  if (info === undefined || pos === undefined) return;
  const { syntax, pair, unconditional } = info;
  const mark = e8.mark();
  if (["(", ")", "\"", "$"].includes(syntax) && regionUsed() && mark !== undefined) {
    if (syntax === "\"" || (syntax === ")" && e8.point() >= mark) || (syntax !== ")" && mark >= e8.point())) {
      const p = e8.makeMarker();
      e8.gotoChar(mark);
      insertPairChar(pair);
      e8.gotoChar(e8.markerPosition(p)!);
      e8.deleteMarker(p);
    } else {
      e8.deleteRegion(pos - 1, pos);
      insertPairChar(pair);
      e8.gotoChar(e8.mark()!);
      insertPairChar(ev);
    }
    return;
  }
  // Not after an escape.
  let escapes = 0;
  for (let p = pos - 1; p > e8.pointMin() && e8.charSyntax(charBefore(p)) === "\\"; p--) escapes++;
  if (escapes % 2 !== 0) return;
  if ([")", "\"", "$"].includes(syntax)) {
    const here = e8.point();
    e8.gotoChar(pos);
    const skips = unconditional || skipSelf(ev);
    e8.gotoChar(here);
    const skipWs = !(unconditional && syntax === "\"") && truthy(e8.variable("electric-pair-skip-whitespace"));
    const closeAhead =
      skips &&
      (() => {
        const p = e8.point();
        if (skipWs) skipWhitespace();
        const found = charAt(e8.point()) === ev;
        e8.gotoChar(p);
        return found;
      })();
    if (closeAhead) {
      if (skipWs) skipWhitespace();
      const chomp = e8.variable("electric-pair-skip-whitespace") === "chomp";
      e8.deleteRegion(pos - 1, chomp ? e8.point() : pos);
      e8.gotoChar(e8.point() + 1);
      return;
    }
  }
  if (["(", "\"", "$"].includes(syntax) && e8.variable("overwrite-mode") !== true) {
    const here = e8.point();
    e8.gotoChar(pos);
    const inhibited = !unconditional && inhibit(ev);
    e8.gotoChar(here);
    if (!inhibited) {
      const p = e8.makeMarker();
      insertPairChar(pair);
      e8.gotoChar(e8.markerPosition(p)!);
      e8.deleteMarker(p);
    }
  }
}

/** RET between a pair opens a line for the close too, as electric-pair-open-newline-between-pairs-psif. */
function openNewlineBetweenPairs(): void {
  if (e8.variable("electric-pair-mode") !== true || !truthy(e8.variable("electric-pair-open-newline-between-pairs"))) return;
  if (lastEvent() !== "\n") return;
  const p = e8.point();
  if (!(e8.pointMin() + 1 < p && p < e8.pointMax())) return;
  let q = p;
  while (q > e8.pointMin() && " \t".includes(charBefore(q))) q--;
  const before = charBefore(q - 1);
  if (before !== "" && before === e8.matchingParen(charAt(p))) {
    // As (save-excursion (newline 1 t)).
    const m = e8.makeMarker();
    e8.callInteractively("newline");
    e8.gotoChar(e8.markerPosition(m)!);
    e8.deleteMarker(m);
  }
}

/** Whether typing this character wraps the region, as electric-pair-will-use-region. */
function willUseRegion(): boolean {
  if (e8.variable("electric-pair-mode") !== true || !regionUsed()) return false;
  const ev = lastEvent();
  const info = ev === undefined ? undefined : syntaxInfo(ev);
  return info !== undefined && ["(", ")", "\"", "$"].includes(info.syntax);
}

e8.defineCommand({
  name: "electric-pair-delete-pair",
  barfIfReadOnly: true,
  doc: "Delete the open and close pair point is between, as DEL does there in Electric Pair mode.",
  run: () => {
    e8.deleteRegion(e8.point(), e8.point() + 1);
    e8.callWithPrefix(e8.prefixArg(), "delete-backward-char");
  },
});

/** DEL between an empty pair deletes both, as electric-pair-mode-map's DEL filter. */
function deletePairBeforeCommand(): void {
  if (e8.variable("electric-pair-mode") !== true || e8.lastKey() !== "DEL") return;
  if (!truthy(e8.variable("electric-pair-delete-adjacent-pairs")) || e8.bufferReadOnly()) return;
  const prev = charBefore(e8.point());
  const next = charAt(e8.point());
  if (prev === "" || next === "") return;
  const info = syntaxInfo(prev);
  if (info !== undefined && ["(", "\"", "$"].includes(info.syntax) && info.pair === next) {
    e8.setThisCommand("electric-pair-delete-pair");
  }
}

e8.defineMinorMode({
  name: "electric-pair-mode",
  global: true,
  doc:
    "Type open parens and quotes in pairs: the closing one goes in after point, and typing it there moves over it. " +
    "With the region active, the pair goes around it.",
  onChange: (on) => {
    for (const [hook, fn] of [
      ["post-self-insert-hook", postSelfInsert],
      ["post-self-insert-hook", openNewlineBetweenPairs],
      ["self-insert-uses-region-functions", willUseRegion],
      ["pre-command-hook", deletePairBeforeCommand],
    ] as const) {
      if (on) e8.addHook(hook, fn);
      else e8.removeHook(hook, fn);
    }
  },
});
