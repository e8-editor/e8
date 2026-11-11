// Comments, after Emacs's newcomment.el: M-; (comment-dwim) comments or
// uncomments the region, or adds a comment at the end of the line, or one
// on a blank line; C-x C-; (comment-line) comments whole lines; M-j breaks
// a comment onto a new line that continues it; C-x ; sets the column
// comments go to. Each major mode says what its comments look like with
// comment-start and comment-end, and its syntax table finds them.

import { escapeRegExp, numberValue as num, truthy } from "subr";

const defvar = (name: string, value: e8.Value, doc: string, local = false) => e8.defineVariable({ name, value, doc, local });
defvar("comment-start", null, "What starts a comment in this mode, with the space after it: \"// \" or \"# \". nil if the mode has no comments.", true);
defvar("comment-end", "", "What ends a comment, with the space before it: \" */\", or \"\" when comments end with the line.", true);
defvar("comment-start-skip", null, "A regexp matching a comment's start and the space after it.", true);
defvar("comment-column", 32, "The column comments at the end of a line go to. C-x ; sets it.", true);
defvar("comment-padding", " ", "What goes between a comment's start and its text.");
defvar("comment-add", 0, "How many more comment starts comment-region and M-; on a blank line add, as Lisp's ;; for comments of their own.", true);
defvar("comment-empty-lines", false, "Whether comment-region comments blank lines too.");
defvar("comment-inline-offset", 1, "The least space between code and the comment after it.");

const str = (name: string): string | undefined => {
  const v = e8.variable(name);
  return typeof v === "string" ? v : undefined;
};
const charAt = (p: number): string => e8.charAfter(p) ?? "";
const bol = (p = e8.point()): number => e8.lineBeginningPosition(p);
const eol = (p = e8.point()): number => e8.lineEndPosition(p);
const indentation = (line: number): number => e8.currentIndentation(e8.lineStart(line));
const blank = (line: number): boolean => /^[ \t]*$/.test(e8.lineText(line));

/** Comment syntax, as comment-normalize-vars checks it is there. */
function commentStart(): string {
  const cs = str("comment-start");
  if (cs === undefined) throw new Error("No comment syntax defined");
  return cs;
}
const commentEnd = (): string => str("comment-end") ?? "";
const trim = (s: string): string => s.trim();

/** comment-start with comment-padding after it and `n` more of its last character, as comment-padright. */
function padRight(s: string, n = 0): string {
  const core = trim(s);
  if (core === "") return s;
  const lpad = /^\s*/.exec(s)![0];
  const existing = s.length - lpad.length - core.length;
  const padding = str("comment-padding") ?? " ";
  const rpad = s.slice(lpad.length + core.length) + padding.slice(Math.min(existing, padding.length));
  return lpad + core + core[core.length - 1].repeat(n) + rpad;
}

/** comment-end with comment-padding before it, as comment-padleft. */
function padLeft(s: string): string {
  const core = s.replace(/^\s+/, "");
  if (core === "") return "";
  const lead = s.length - core.length;
  const padding = str("comment-padding") ?? " ";
  return padding.slice(Math.min(lead, padding.length)) + s.slice(0, lead) + core;
}

/** Whether a comment starts at `p`, as the syntax table says, and how long its starter is. */
function commentStartAt(p: number): number | undefined {
  const c = charAt(p);
  if (c === "") return undefined;
  const d = e8.syntaxEntry(c) ?? "";
  const flags = d.slice(2);
  if (d[0] === "<" || d[0] === "!") return 1;
  if (flags.includes("1")) {
    const next = e8.syntaxEntry(charAt(p + 1)) ?? "";
    if (next.slice(2).includes("2")) return 2;
  }
  // Modes without comment syntax in their table, by comment-start itself.
  const cs = trim(str("comment-start") ?? "");
  if (cs !== "" && e8.bufferText(p, p + cs.length) === cs && !hasCommentSyntax()) return cs.length;
  return undefined;
}

/** Whether the syntax table knows the mode's comments, as comment-use-syntax. */
function hasCommentSyntax(): boolean {
  const cs = trim(str("comment-start") ?? "");
  if (cs === "") return false;
  const d = e8.syntaxEntry(cs[0]) ?? "";
  return d[0] === "<" || d[0] === "!" || d.slice(2).includes("1");
}

/**
 * Finds the next comment's start from `from` before `limit`, not in a
 * string, as comment-search-forward: returns where it starts, leaving
 * point after its starter and the space after.
 */
function commentSearchForward(from: number, limit: number): number | undefined {
  for (let p = from; p < limit; p++) {
    const len = commentStartAt(p);
    if (len === undefined) continue;
    const st = e8.syntaxPpss(p);
    if (st.inString !== null) continue;
    if (st.inComment !== null) {
      // Already in a comment: its start.
      const start = st.start!;
      if (start < from) continue;
      return skipStarter(start, commentStartAt(start) ?? len);
    }
    return skipStarter(p, len);
  }
  return undefined;
}

/** Puts point after a comment's starter, its repeats and the space after, as matching comment-start-skip leaves it. */
function skipStarter(start: number, len: number): number {
  const starter = e8.bufferText(start, start + len);
  let q = start + len;
  // Repeats of the starter's last character, as ;; or ///.
  while (charAt(q) === starter[starter.length - 1] && len === 1) q++;
  while (charAt(q) === " " || charAt(q) === "\t") q++;
  e8.gotoChar(q);
  return start;
}

/** Where the comment on point's line starts, if it has one. */
function commentOnLine(line: number): number | undefined {
  const p = e8.point();
  const found = commentSearchForward(e8.lineStart(line), e8.lineEnd(line));
  e8.gotoChar(p);
  return found;
}

/** Whether the text from `beg` to `end` is only comments and whitespace, as comment-only-p. */
function commentOnly(beg: number, end: number): boolean {
  for (let line = e8.lineOf(beg); line <= e8.lineOf(Math.max(beg, end - 1)); line++) {
    if (blank(line)) continue;
    const start = e8.lineStart(line) + /^[ \t]*/.exec(e8.lineText(line))![0].length;
    if (commentOnLine(line) !== start) return false;
  }
  return true;
}

/** The lines a region covers: from its start's line to its end's, leaving out a line the end is at the start of. */
function regionLines(beg: number, end: number): [number, number] {
  const first = e8.lineOf(beg);
  let last = e8.lineOf(end);
  if (end > beg && end === e8.lineStart(last) && last > first) last--;
  return [first, last];
}

/** Comments each line of the region at its least indentation, as comment-region with the indent style. */
export function commentRegion(begIn: number, endIn: number, arg: number): void {
  if (arg < 0) return uncommentRegion(begIn, endIn, -arg);
  // The region without the blank lines around it, as comment-region-default-1 sanitizes it.
  let b = begIn;
  while (b < e8.bufferSize() && " \t\n\r".includes(charAt(b))) b++;
  const beg = Math.max(begIn, bol(b));
  let e = endIn;
  while (e > 0 && " \t\n\r".includes(charAt(e - 1))) e--;
  const end = Math.min(endIn, eol(e));
  if (beg >= end) throw new Error("Nothing to comment");
  // Comments that end with the line end the region's last line there.
  if (commentEnd() === "" && end !== eol(end)) {
    const p = e8.makeMarker();
    e8.gotoChar(end);
    e8.insert("\n");
    e8.call("indent-according-to-mode");
    e8.gotoChar(e8.markerPosition(p)!);
    e8.deleteMarker(p);
  }
  const add = num("comment-add", 0) + arg - 1;
  const cs = padRight(commentStart(), add);
  const ceRaw = commentEnd();
  const ce = ceRaw === "" ? "" : padLeft(ceRaw);
  const [first, last] = regionLines(beg, end);
  const empty = truthy(e8.variable("comment-empty-lines"));
  let min = Infinity;
  for (let l = first; l <= last; l++) if (empty || !blank(l)) min = Math.min(min, blank(l) ? Infinity : indentation(l));
  if (min === Infinity) min = 0;
  const p = e8.makeMarker();
  for (let l = last; l >= first; l--) {
    if (!empty && blank(l)) continue;
    e8.gotoChar(e8.lineStart(l));
    e8.moveToColumn(min);
    if (e8.currentColumn() < min) e8.insert(" ".repeat(min - e8.currentColumn()));
    // Trailing whitespace makes no comment of its own.
    const content = e8.lineText(l).replace(/[ \t]+$/, "");
    e8.insert(content.trim() === "" ? cs.replace(/\s+$/, "") : cs);
    if (ce !== "") {
      e8.gotoChar(e8.lineEnd(l));
      e8.insert(ce);
    }
  }
  e8.gotoChar(e8.markerPosition(p)!);
  e8.deleteMarker(p);
}

/** Takes the comment starts and ends out of the region, as uncomment-region: all of them, or `arg` levels. */
function uncommentRegion(beg: number, end: number, arg?: number): void {
  const cs = trim(commentStart());
  const ce = trim(commentEnd());
  const [first, last] = regionLines(beg, end);
  const padding = str("comment-padding") ?? " ";
  const p = e8.makeMarker();
  let found = false;
  for (let l = last; l >= first; l--) {
    const start = commentOnLine(l);
    if (start === undefined) continue;
    found = true;
    // The starter, its last character repeated as it may be, as
    // (comment-padright comment-start 're) matches it; with `arg`, that
    // many levels only.
    let q = start + (e8.bufferText(start, start + cs.length) === cs ? cs.length : (commentStartAt(start) ?? 0));
    const last = cs[cs.length - 1];
    let extra = arg === undefined ? Infinity : arg - 1;
    while (extra > 0 && charAt(q) === last) {
      q++;
      extra--;
    }
    if (e8.bufferText(q, q + padding.length) === padding) q += padding.length;
    if (ce !== "") {
      const lineEnd = e8.lineEnd(l);
      const text = e8.bufferText(q, lineEnd);
      const m = new RegExp(`[ \\t]*${escapeRegExp(ce)}[ \\t]*$`).exec(text);
      if (m !== null) e8.deleteRegion(q + m.index, lineEnd);
    }
    e8.deleteRegion(start, q);
  }
  e8.gotoChar(e8.markerPosition(p)!);
  e8.deleteMarker(p);
  if (!found) throw new Error("Can't find any comment");
}

function commentOrUncommentRegion(beg: number, end: number, arg: e8.PrefixArg): void {
  if (commentOnly(beg, end)) uncommentRegion(beg, end, arg === null ? undefined : e8.prefixNumericValue(arg));
  else commentRegion(beg, end, arg === null ? 1 : e8.prefixNumericValue(arg));
}

/** The column for the comment at point, as comment-choose-indent: near comment-column, within the fill column, as the comments around align. */
function chooseIndent(indent: number): number {
  const fill = num("fill-column", 70);
  let max = e8.currentColumn() + (fill - columnAt(eol()));
  let q = e8.point();
  while (q > bol() && " \t".includes(charAt(q - 1))) q--;
  let min = q === bol() ? 0 : num("comment-inline-offset", 1) + columnAt(q);
  if (max < min) max = min;
  let target = indent;
  if (max <= target) target = max;
  // As the comment on the line before is aligned, if that fits.
  const line = e8.lineOf(e8.point());
  if (line > 0) {
    const other = commentOnLine(line - 1);
    if (other !== undefined) {
      const col = columnAt(other);
      if (col <= max && col >= min) return col;
    }
  }
  // Or those after.
  for (let l = line + 1; l < e8.lineCount(); l++) {
    const other = commentOnLine(l);
    if (other === undefined) break;
    const omax = columnAt(other) + (fill - columnAt(e8.lineEnd(l)));
    let o = other;
    while (o > e8.lineStart(l) && " \t".includes(charAt(o - 1))) o--;
    const omin = columnAt(o) + 1;
    if (omax >= min && omin <= max) {
      min = Math.max(omin, min);
      max = Math.min(omax, max);
    } else break;
  }
  return Math.max(min, Math.min(max, target));
}

const columnAt = (p: number): number =>
  e8.saveExcursion(() => {
    e8.gotoChar(p);
    return e8.currentColumn();
  });

/** Puts a comment at the end of the line, or indents the one there, as comment-indent. */
function commentIndent(): void {
  const starter = commentStart();
  const ender = commentEnd();
  e8.gotoChar(bol());
  let begpos = commentSearchForward(e8.point(), eol());
  let cpos: e8.Marker;
  if (begpos !== undefined) {
    cpos = e8.makeMarker();
  } else {
    e8.gotoChar(eol());
    const p = e8.point();
    e8.indentTo(num("comment-column", 32));
    // A space before it, as sh needs and is neater.
    if (e8.point() > 0 && !["\n", "\t", " "].includes(charAt(e8.point() - 1))) e8.insert(" ");
    void p;
    begpos = e8.point();
    e8.insert(starter);
    cpos = e8.makeMarker();
    e8.insert(ender);
  }
  e8.gotoChar(begpos);
  // As comment-indent-default: comment-column for a comment after code, or the code's indentation for one alone on its line.
  const alone = e8.currentColumn() === indentation(e8.lineOf(begpos));
  const starts = commentStartAt(begpos) ?? 1;
  const doubled = starts === 1 && charAt(begpos + 1) === charAt(begpos);
  const tripled = doubled && charAt(begpos + 2) === charAt(begpos);
  if (doubled && (tripled || !alone)) {
    reindent(chooseIndent(0));
  } else if (!alone) {
    reindent(chooseIndent(num("comment-column", 32)));
  } else if (starts === 1 && !doubled && num("comment-add", 0) > 0) {
    // A comment alone of one starter, where comment-region doubles them, goes to comment-column.
    reindent(num("comment-column", 32));
  } else {
    e8.call("indent-according-to-mode");
  }
  e8.gotoChar(e8.markerPosition(cpos)!);
  e8.deleteMarker(cpos);
}

/** Moves the comment at point to `column`, replacing the whitespace before it. */
function reindent(column: number): void {
  if (e8.currentColumn() === column) return;
  let q = e8.point();
  while (q > bol() && " \t".includes(charAt(q - 1))) q--;
  e8.deleteRegion(q, e8.point());
  e8.gotoChar(q);
  e8.indentTo(column);
}

/** Kills the comment on the line, and the whitespace before it, as comment-kill. */
function commentKill(count: number): void {
  for (let i = 0; i < Math.max(count, 1); i++) {
    const line = e8.lineOf(e8.point());
    const start = commentOnLine(line);
    if (start !== undefined) {
      let q = start;
      while (q > e8.lineStart(line) && " \t".includes(charAt(q - 1))) q--;
      e8.killRegion(q, e8.lineEnd(line));
      e8.call("indent-according-to-mode");
    }
    if (count > 1 && line + 1 < e8.lineCount()) e8.gotoChar(e8.lineStart(line + 1));
  }
}

const regionUsed = (): boolean => e8.regionActive() && e8.mark() !== undefined && e8.mark() !== e8.point();
const region = (): [number, number] => [Math.min(e8.point(), e8.mark()!), Math.max(e8.point(), e8.mark()!)];
const barf = (): void => {
  if (e8.bufferReadOnly()) throw new Error(`Buffer is read-only: #<buffer ${e8.bufferName()}>`);
};

e8.defineCommand({
  name: "comment-dwim",
  doc:
    "Comment or uncomment the region if it is active. Otherwise put a comment at the end of the line, or indent the one there, " +
    "or start one on a blank line. With a prefix argument and no region, kill the line's comment.",
  run: () => {
    barf();
    commentStart();
    const arg = e8.prefixArg();
    if (regionUsed()) return commentOrUncommentRegion(...region(), arg);
    if (!blank(e8.lineOf(e8.point()))) {
      if (arg !== null) commentKill(typeof arg === "number" ? arg : 1);
      else commentIndent();
      return;
    }
    const add = num("comment-add", 0) + (arg === null ? 0 : e8.prefixNumericValue(arg) - 1);
    e8.call("indent-according-to-mode");
    e8.insert(padRight(commentStart(), add));
    const ce = commentEnd();
    if (ce !== "") {
      const p = e8.makeMarker();
      e8.insert(padLeft(ce));
      e8.gotoChar(e8.markerPosition(p)!);
      e8.deleteMarker(p);
    }
  },
});

e8.defineCommand({
  name: "comment-region",
  doc: "Comment out each line of the region. With a prefix argument N, use N comment starts; negative, uncomment instead.",
  run: () => {
    barf();
    if (e8.mark() === undefined) e8.userError("The mark is not set now, so there is no region");
    commentRegion(...region(), e8.prefixNumericValue(e8.prefixArg()));
  },
});

e8.defineCommand({
  name: "uncomment-region",
  doc: "Take the comment starts and ends out of the region's lines. With a prefix argument, take out that many levels.",
  run: () => {
    barf();
    commentStart();
    if (e8.mark() === undefined) e8.userError("The mark is not set now, so there is no region");
    const arg = e8.prefixArg();
    uncommentRegion(...region(), arg === null ? undefined : e8.prefixNumericValue(arg));
  },
});

e8.defineCommand({
  name: "comment-or-uncomment-region",
  doc: "Uncomment the region's lines if they are all comments, else comment them.",
  run: () => {
    barf();
    commentStart();
    if (e8.mark() === undefined) e8.userError("The mark is not set now, so there is no region");
    commentOrUncommentRegion(...region(), e8.prefixArg());
  },
});

e8.defineCommand({
  name: "comment-line",
  doc:
    "Comment or uncomment the current line, or the region's lines, and move to the next line. " +
    "With a prefix argument N, the N lines from this one; negative, the lines above.",
  run: () => {
    barf();
    commentStart();
    if (regionUsed()) {
      const [a, b] = region();
      return commentOrUncommentRegion(bol(a), eol(b), null);
    }
    let n = e8.prefixNumericValue(e8.prefixArg());
    if (e8.lastCommand() === "comment-line-backward" && n >= 0) n = -n;
    const start = bol();
    const target = e8.lineOf(e8.point()) + n - 1;
    const end = target < 0 ? 0 : target >= e8.lineCount() ? e8.bufferSize() : e8.lineEnd(target);
    e8.gotoChar(end);
    commentOrUncommentRegion(Math.min(start, end), Math.max(start, end), null);
    const next = e8.lineOf(e8.point()) + 1;
    e8.gotoChar(next < e8.lineCount() ? e8.lineStart(next) : e8.bufferSize());
    e8.gotoChar(e8.point() + /^[ \t]*/.exec(e8.lineText(e8.lineOf(e8.point())))![0].length);
    if (n < 0) e8.setThisCommand("comment-line-backward" as e8.CommandName);
  },
});

e8.defineCommand({
  name: "comment-line-backward",
  doc: "What comment-line becomes when it goes backward, so typing it again goes on backward.",
  run: () => e8.call("comment-line"),
});

e8.defineCommand({
  name: "comment-indent",
  doc: "Put a comment at the end of the line at comment-column, or indent the comment there to it.",
  run: () => {
    barf();
    commentIndent();
  },
});

e8.defineCommand({
  name: "comment-kill",
  doc: "Kill the comment on this line. With a prefix argument, on that many lines.",
  run: () => {
    barf();
    commentKill(e8.prefixNumericValue(e8.prefixArg()));
  },
});

e8.defineCommand({
  name: "comment-set-column",
  doc: "Set comment-column to point's column. With C-u, to that of the comment on the line before; with a negative argument, kill the comment.",
  run: () => {
    const arg = e8.prefixArg();
    if (arg === "-" || (typeof arg === "number" && arg < 0)) return commentKill(1);
    if (Array.isArray(arg)) {
      const line = e8.lineOf(e8.point());
      for (let l = line - 1; l >= 0; l--) {
        const c = commentOnLine(l);
        if (c !== undefined) {
          const col = columnAt(c);
          e8.setVariable("comment-column", col);
          e8.message(`Comment column set to ${col}`);
          return;
        }
      }
      return;
    }
    e8.setVariable("comment-column", e8.currentColumn());
    e8.message(`Comment column set to ${e8.currentColumn()}`);
  },
});

e8.defineCommand({
  name: "comment-indent-new-line",
  doc: "Break the line, continuing the comment point is in on the new one, as M-j does; outside a comment, a newline that indents.",
  run: () => {
    barf();
    const st = e8.syntaxPpss();
    const cs = str("comment-start");
    if (st.inComment === null || cs === undefined) {
      e8.call("default-indent-new-line" as e8.CommandName);
      return;
    }
    const start = st.start!;
    // The starter as written on this line: its characters, the last one's
    // repeats, as ;; or ///, and the padding after, as comment-start-skip matches.
    let q = start + (commentStartAt(start) ?? 1);
    while (q < e8.point() && charAt(q) === charAt(q - 1)) q++;
    let pad = q;
    while (pad < e8.point() && " \t".includes(charAt(pad))) pad++;
    const starter = e8.bufferText(start, pad);
    const column = columnAt(start);
    // The whitespace either side goes.
    let a = e8.point();
    let b = a;
    while (a > 0 && " \t".includes(charAt(a - 1))) a--;
    while (b < e8.bufferSize() && " \t".includes(charAt(b))) b++;
    e8.deleteRegion(a, b);
    e8.gotoChar(a);
    const ce = commentEnd();
    if (ce !== "") {
      // A comment with an end is continued with comment-continue's start.
      e8.insertAndInherit("\n");
      e8.indentTo(column);
      e8.insert(starter.replace(/^\S/, " "));
      return;
    }
    e8.insertAndInherit("\n");
    e8.indentTo(column);
    e8.insert(starter);
  },
});

e8.defineCommand({
  name: "default-indent-new-line",
  doc: "Break the line and indent the new one, continuing a comment point is in, as comment-indent-new-line does.",
  run: () => {
    if (e8.syntaxPpss().inComment !== null && str("comment-start") !== undefined) {
      e8.call("comment-indent-new-line");
      return;
    }
    e8.insertAndInherit("\n");
    let a = e8.point() - 1;
    while (a > 0 && " \t".includes(charAt(a - 1))) a--;
    e8.deleteRegion(a, e8.point() - 1);
    e8.call("indent-according-to-mode");
  },
});

e8.bindKey("M-;", "comment-dwim");
e8.bindKey("C-x C-;", "comment-line");
e8.bindKey("C-x ;", "comment-set-column");
e8.bindKey("M-j", "default-indent-new-line");
e8.bindKey("C-M-j", "default-indent-new-line");
