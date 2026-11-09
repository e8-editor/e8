import { allMatches, defineGlobalizedMinorMode, forwardLine } from "subr";
// Basic editing commands that Emacs writes in Lisp, after its simple.el.
// E8 loads this file at startup, before init.ts.

// Prefix arguments: C-u, M-<digit> and C--.
//
// A prefix command does nothing itself. It leaves a prefix argument for the
// next command and binds, for one key only, the keys that continue the
// argument: more digits, a minus sign, or another C-u. Any other key runs its
// command with the argument.

/** How the argument typed so far is shown in the echo area, such as "C-u 12-". */
function describeArgument(arg: e8.PrefixArg): string {
  if (Array.isArray(arg)) {
    const times = Math.max(1, Math.round(Math.log(Math.abs(arg[0])) / Math.log(4)));
    return Array(times).fill("C-u").join(" ") + (arg[0] < 0 ? " -" : "") + "-";
  }
  if (arg === "-") {
    return "C-u --";
  }
  return arg === null ? "" : `C-u ${arg}-`;
}

/** Leaves `arg` for the next command, and lets the next key continue it. */
function continueArgument(arg: e8.PrefixArg): void {
  e8.setPrefixArg(arg);
  const keys: { [keys: string]: e8.CommandName } = { "C-u": "universal-argument-more" };
  for (let digit = 0; digit <= 9; digit++) {
    keys[String(digit)] = "digit-argument";
  }
  // After digits, a minus sign is typed with the argument, as in Emacs:
  // C-u 3 - inserts three dashes.
  if (typeof arg !== "number") {
    keys["-"] = "negative-argument";
  }
  e8.setTransientMap(keys);
  // Shown as Emacs echoes the keys typed, not logged.
  e8.message(describeArgument(arg), { log: false });
}

const universalArgument = e8.defineCommand({
  name: "universal-argument",
  doc:
    "Begin a prefix argument for the next command.\n\n" +
    "Digits or a minus sign typed after it make the argument; without them it is 4, " +
    "and each further C-u multiplies it by 4. Most commands repeat that many times.",
  run: () => continueArgument([4]),
});

e8.defineCommand({
  name: "universal-argument-more",
  doc:
    "Multiply the prefix argument by 4, as a second C-u does.\n\n" +
    "After digits, it ends the argument instead, so digits typed after it are inserted.",
  run: () => {
    const arg = e8.prefixArg();
    if (Array.isArray(arg)) {
      continueArgument([arg[0] * 4]);
    } else if (arg === "-") {
      continueArgument([-4]);
    } else {
      e8.setPrefixArg(arg);
    }
  },
});

const digitArgument = e8.defineCommand({
  name: "digit-argument",
  doc: "Add the digit typed to the prefix argument, as M-5 or the digits after C-u do.",
  run: () => {
    const digit = Number((e8.lastKey() ?? "").slice(-1));
    const arg = e8.prefixArg();
    let next: e8.PrefixArg;
    if (typeof arg === "number") {
      next = arg * 10 + (arg < 0 ? -digit : digit);
    } else if (arg === "-") {
      // A minus followed by 0 stays "-", so that -01 works.
      next = digit === 0 ? "-" : -digit;
    } else {
      next = digit;
    }
    continueArgument(next);
  },
});

const negativeArgument = e8.defineCommand({
  name: "negative-argument",
  doc: "Make the prefix argument negative, as C-- or M-- does.",
  run: () => {
    const arg = e8.prefixArg();
    continueArgument(typeof arg === "number" ? -arg : arg === "-" ? null : "-");
  },
});

e8.bindKey("C-u", universalArgument);
for (let digit = 0; digit <= 9; digit++) {
  for (const modifiers of ["M-", "C-", "C-M-"]) {
    e8.bindKey(`${modifiers}${digit}`, digitArgument);
  }
}
for (const keys of ["M--", "C--", "C-M--"]) {
  e8.bindKey(keys, negativeArgument);
}

// Yanking older kills: M-y.

e8.defineVariable({ name: "yank-from-kill-ring-rotate", doc: "Whether yanking a kill chosen from the minibuffer makes it the one C-y inserts next.", value: true });
e8.defineVariable({ name: "read-from-kill-ring-history", doc: "Kills chosen from the minibuffer, newest first.", value: [] });

/** Reads one of the kills with completion, newest first, as read-from-kill-ring. */
async function readFromKillRing(prompt: string): Promise<string> {
  return e8.completingRead(prompt, e8.killRing(), { history: "read-from-kill-ring-history" });
}

/**
 * Inserts a kill as C-y does, the mark before it, and makes it the one C-y
 * inserts next, as yank-from-kill-ring; with C-u, point goes before it.
 */
function yankFromKillRing(text: string, arg: e8.PrefixArg): void {
  e8.pushMark(e8.point());
  e8.insertForYank(text);
  if (e8.variable("yank-from-kill-ring-rotate") !== false && e8.variable("yank-from-kill-ring-rotate") !== null) {
    const pos = e8.killRing().indexOf(text);
    if (pos >= 0) e8.setKillRingYankPointer(pos);
    else e8.killNew(text);
  }
  if (Array.isArray(arg)) {
    const mark = e8.mark()!;
    e8.setMark(e8.point());
    e8.gotoChar(mark);
  }
}

e8.defineCommand({
  name: "yank-from-kill-ring",
  doc: "Insert a kill chosen from the minibuffer, with completion; with C-u, point goes before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: e8.PrefixArg) => yankFromKillRing(await readFromKillRing("Yank from kill-ring: "), arg),
});

const yankPop = e8.defineCommand({
  name: "yank-pop",
  doc:
    "Replace the text just yanked with an earlier kill.\n\n" +
    "Right after C-y or M-y. Repeat it to go further back through the kill ring; " +
    "a prefix argument N goes N kills back at once, and a negative one goes forward. " +
    "After anything else, choose a kill from the minibuffer, as yank-from-kill-ring does.",
  run: async () => {
    // Not after a yank, it reads a kill from the minibuffer, as Emacs 28
    // and later do, failing first if there is nothing to choose from.
    if (e8.lastCommand() !== "yank") {
      e8.currentKill(0);
      const prefix = e8.prefixArg();
      yankFromKillRing(await readFromKillRing("Yank from kill-ring: "), prefix);
      return;
    }
    // So that another M-y can follow this one.
    e8.setThisCommand("yank");
    const point = e8.point();
    const mark = e8.mark();
    if (mark === undefined) {
      e8.userError("The mark is not set now, so there is no region");
    }
    const pointWasFirst = point < mark;
    const start = Math.min(point, mark);
    e8.deleteRegion(start, Math.max(point, mark));
    e8.setMark(start);
    e8.insertForYank(e8.currentKill(e8.prefixNumericValue(), { properties: true }));
    if (pointWasFirst) {
      const end = e8.point();
      e8.gotoChar(start);
      e8.setMark(end);
    }
  },
});
e8.bindKey("M-y", yankPop);

// Fundamental mode, the major mode with no specialisations, and the mode
// new buffers start in.

e8.defineMajorMode({
  name: "fundamental-mode",
  modeName: "Fundamental",
  doc: "The major mode with no specialisations. Other major modes are defined by how they differ from it.",
});

// Special mode, the parent of modes for buffers that are read rather than
// edited, as simple.el's: q quits, g makes the buffer again, SPC and DEL
// page, and the keymap is suppressed, digits giving a prefix argument.

e8.defineMajorMode({
  name: "special-mode",
  modeName: "Special",
  doc: "The parent of modes for buffers that are read rather than edited: q quits the window, g makes the buffer again, SPC and DEL page, < and > go to the ends, and h or ? describes the mode.",
  bindings: {
    q: "quit-window",
    SPC: "scroll-up-command",
    "S-SPC": "scroll-down-command",
    DEL: "scroll-down-command",
    h: "describe-mode",
    "?": "describe-mode",
    ">": "end-of-buffer",
    "<": "beginning-of-buffer",
    g: "revert-buffer",
    "-": "negative-argument",
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [String(d), "digit-argument"])),
  } as Record<string, e8.CommandName>,
  setup: () => e8.setReadOnly(true),
});

// Overwrite mode: <insert>.

const overwriteMode = e8.defineMinorMode({
  name: "overwrite-mode",
  lighter: " Ovwrt",
  doc:
    "Replace text rather than insert it: each typed character replaces the one after point.\n\n" +
    "At the end of a line, characters are inserted as usual.",
});
e8.bindKey("<insert>", overwriteMode);

// Long lines, after simple.el: toggle-truncate-lines, and visual-line-mode
// with commands that move by screen lines.

e8.defineCommand({
  name: "toggle-truncate-lines",
  doc:
    "Turn truncate-lines on in this buffer if it is off, and off if it is on.\n\n" +
    "With truncation, long lines are cut off at the window's edge and the window scrolls sideways; " +
    "without it, they continue on the next screen line. A positive prefix argument turns truncation on, " +
    "and zero or a negative one turns it off.",
  run: () => {
    const arg = e8.prefixArg();
    const on = arg === null ? !e8.variable("truncate-lines") : e8.prefixNumericValue(arg) > 0;
    e8.setVariable("truncate-lines", on);
    e8.message(`Truncate long lines ${on ? "enabled" : "disabled"}`);
  },
});

const beginningOfVisualLine = e8.defineCommand({
  name: "beginning-of-visual-line",
  doc: "Move point to the start of the screen line it is on, which is not the start of its line where a long line continues.",
  run: () => {
    e8.gotoChar(e8.screenLine(e8.point()).start);
  },
});

const endOfVisualLine = e8.defineCommand({
  name: "end-of-visual-line",
  doc:
    "Move point to the end of the screen line it is on.\n\n" +
    "Where the line continues on the next screen line, point stops before the last character, which shows where the line breaks.",
  run: () => {
    const line = e8.screenLine(e8.point());
    e8.gotoChar(line.continued ? Math.max(line.start, line.end - 1) : line.end);
  },
});

const killVisualLine = e8.defineCommand({
  name: "kill-visual-line",
  doc:
    "Kill the rest of the screen line, or the newline if point is at the end of a line.\n\n" +
    "Where the line continues, it kills to where the next screen line starts.",
  run: () => {
    const point = e8.point();
    const line = e8.screenLine(point);
    if (point >= line.end) {
      e8.call("kill-line");
    } else {
      // kill-region kills between point and the mark; the mark is put back after.
      const mark = e8.mark();
      // Point after the mark, so a kill joining an earlier one goes after it.
      e8.setMark(point);
      e8.gotoChar(line.end);
      e8.call("kill-region");
      e8.setMark(mark ?? null);
    }
  },
});

e8.defineVariable({
  name: "visual-line-fringe-indicators",
  doc:
    "The fringe indicators visual-line-mode shows where it continues a line: [LEFT, RIGHT], each a fringe bitmap's name or nil for none.\n\n" +
    "Both nil by default, as in Emacs, so lines wrapped at words show no curly arrows; [\"left-curly-arrow\", \"right-curly-arrow\"] shows the arrows continued lines have outside the mode.",
  value: [null, null],
});

e8.defineMinorMode({
  name: "visual-line-mode",
  lighter: " Wrap",
  doc:
    "Continue long lines at word boundaries, and make C-a, C-e and C-k work on screen lines.\n\n" +
    "It turns word-wrap on in the buffer and turns truncate-lines off, lets windows that share the frame's width wrap too (truncate-partial-width-windows), " +
    "and shows visual-line-fringe-indicators, none by default, where lines continue.",
  bindings: {
    "C-a": beginningOfVisualLine,
    "C-e": endOfVisualLine,
    "C-k": killVisualLine,
  },
  onChange: (on) => {
    if (on) {
      e8.setVariable("word-wrap", true);
      e8.setVariable("truncate-lines", false);
      // As Emacs's visual-line-mode: narrow side-by-side windows wrap too.
      e8.makeLocalVariable("truncate-partial-width-windows");
      e8.setVariable("truncate-partial-width-windows", null);
      // As Emacs's: the continuation indicator is the buffer's own, from
      // visual-line-fringe-indicators, ahead of the alist's.
      const indicators = e8.variable("visual-line-fringe-indicators");
      const alist = e8.variable("fringe-indicator-alist");
      e8.makeLocalVariable("fringe-indicator-alist");
      e8.setVariable("fringe-indicator-alist", [
        [e8.intern("continuation"), ...(Array.isArray(indicators) ? indicators : [indicators ?? null])],
        ...(Array.isArray(alist) ? alist : []),
      ]);
    } else {
      e8.killLocalVariable("word-wrap");
      e8.killLocalVariable("truncate-lines");
      e8.killLocalVariable("truncate-partial-width-windows");
      e8.killLocalVariable("fringe-indicator-alist");
    }
  },
});
defineGlobalizedMinorMode("global-visual-line-mode", "visual-line-mode", "Turn visual-line-mode on in every buffer: long lines continue at word boundaries everywhere.");

// Transposing, after simple.el's transpose-subr.

/**
 * Swaps the text between two pairs of positions, as transpose-subr-1 does,
 * with the same insertions and deletions, so point and the mark move as
 * Emacs's markers do.
 */
function transposeRegions(pos1: [number, number], pos2: [number, number]): void {
  const sorted = (p: [number, number]): [number, number] => (p[0] > p[1] ? [p[1], p[0]] : p);
  let [a, b] = [sorted(pos1), sorted(pos2)];
  if (a[0] > b[0]) [a, b] = [b, a];
  if (a[1] > b[0]) throw new Error("Don\u2019t have two things to transpose");
  const mark = e8.mark();
  const point = { pos: e8.point() };
  const markers = [point, ...(mark === undefined ? [] : [{ pos: mark }])];
  const boundary = { pos: b[0] };
  markers.push(boundary);
  // The insertion before markers is a real one, so the markers the core
  // keeps, such as other windows' points, move as Emacs's do too.
  const insert = (at: number, text: string, beforeMarkers: boolean): void => {
    e8.gotoChar(at);
    if (beforeMarkers) e8.insertBeforeMarkers(text);
    else e8.insert(text);
    for (const m of markers) if (m.pos > at || (beforeMarkers && m.pos === at)) m.pos += text.length;
  };
  const remove = (from: number, to: number): string => {
    const text = e8.deleteRegion(from, to);
    for (const m of markers) {
      if (m.pos >= to) m.pos -= to - from;
      else if (m.pos > from) m.pos = from;
    }
    return text;
  };
  const word = e8.bufferText(b[0], b[1]);
  const len1 = a[1] - a[0];
  // All or nothing, as read-only text such as a prompt may refuse a deletion
  // after the insertion was made.
  e8.atomicChangeGroup(() => {
    insert(a[1], word, true);
    const first = remove(a[0], a[0] + len1);
    insert(boundary.pos, first, false);
    remove(boundary.pos + len1, boundary.pos + len1 + (b[1] - b[0]));
  });
  e8.gotoChar(point.pos);
  if (mark !== undefined) e8.setMark(markers[1].pos);
}

/**
 * Moves the object before point past `arg` objects, as transpose-subr does.
 * `mover` moves over `n` objects, forward if positive, or with `special`
 * returns the ends of the object `n` objects away.
 */
export function transposeSubr(mover: (n: number) => void, arg: number): void;
export function transposeSubr(mover: (n: number) => [number, number], arg: number, special: true): void;
export function transposeSubr(mover: ((n: number) => void) | ((n: number) => [number, number]), arg: number, special = false): void {
  // With `special`, the mover gives the object's ends itself, as transpose-sexps' does.
  const aux = special
    ? (mover as (n: number) => [number, number])
    : (x: number): [number, number] => {
        mover(x);
        const first = e8.point();
        mover(-x);
        return [first, e8.point()];
      };
  if (arg === 0) {
    const mark = e8.mark();
    if (mark === undefined) throw new Error("No mark set in this buffer");
    const p = e8.point();
    const pos1 = aux(1);
    e8.gotoChar(mark);
    const pos2 = aux(1);
    e8.gotoChar(p);
    transposeRegions(pos1, pos2);
    e8.call("exchange-point-and-mark");
  } else if (arg > 0) {
    const pos1 = aux(-1);
    const pos2 = aux(arg);
    transposeRegions(pos1, pos2);
    e8.gotoChar(pos2[0]);
  } else {
    const pos1 = aux(-1);
    e8.gotoChar(pos1[0]);
    const pos2 = aux(arg);
    transposeRegions(pos1, pos2);
    e8.gotoChar(pos2[0] + (pos1[1] - pos1[0]));
  }
}

const transposeLines = e8.defineCommand({
  name: "transpose-lines",
  doc:
    "Exchange the line point is on with the line before it, leaving point after both.\n\n" +
    "With a prefix argument, move the line before point past that many lines; with 0, exchange the line point " +
    "is on with the line the mark is on.",
  run: () => {
    transposeSubr((n) => {
      if (n > 0) {
        let short = forwardLine(n);
        if (e8.point() === 0 || e8.bufferText(e8.point() - 1, e8.point()) !== "\n") short++;
        // Through newline, which amalgamates undo as self-insert-command does.
        if (short > 0) {
          e8.undoAutoAmalgamate();
          e8.insert("\n".repeat(short));
        }
      } else {
        forwardLine(n);
      }
    }, e8.prefixNumericValue());
  },
});
e8.bindKey("C-x C-t", transposeLines);

/** Moves point n characters, stopping at the buffer's ends with forward-char's errors. */
function forwardChar(n: number): void {
  const to = e8.point() + n;
  if (to < e8.pointMin()) {
    e8.gotoChar(e8.pointMin());
    throw new Error("Beginning of buffer");
  }
  if (to > e8.pointMax()) {
    e8.gotoChar(e8.pointMax());
    throw new Error("End of buffer");
  }
  e8.gotoChar(to);
}

const transposeChars = e8.defineCommand({
  name: "transpose-chars",
  doc:
    "Exchange the characters around point, moving forward one character.\n\n" +
    "At the end of a line, exchange the two characters before point. With a prefix argument, move the " +
    "character before point that many characters forward, or back if negative; with 0, exchange the " +
    "characters at point and the mark.",
  run: () => {
    const p = e8.point();
    // At the end of a line it goes back a character first, whatever the argument, as Emacs's does.
    if (p === e8.lineEnd(e8.lineOf(p)) && p > 0) e8.gotoChar(p - 1);
    transposeSubr(forwardChar, e8.prefixNumericValue());
  },
});
e8.bindKey("C-t", transposeChars);

const transposeWords = e8.defineCommand({
  name: "transpose-words",
  doc:
    "Exchange the words around point, leaving point after both.\n\n" +
    "With a prefix argument, move the word before point past that many words; with 0, exchange the words " +
    "at point and the mark.",
  run: () => transposeSubr((n) => e8.callWithPrefix(n, "forward-word"), e8.prefixNumericValue()),
});
e8.bindKey("M-t", transposeWords);

const openLine = e8.defineCommand({
  name: "open-line",
  doc: "Insert a newline after point, leaving point where it is; with a prefix argument, that many.",
  run: () => {
    const n = e8.prefixNumericValue();
    if (n < 0) throw new Error("Repetition argument has to be non-negative");
    const p = e8.point();
    e8.insert("\n".repeat(n));
    e8.gotoChar(p);
  },
});
e8.bindKey("C-o", openLine);

e8.defineVariable({
  name: "electric-indent-mode",
  doc: "Whether RET indents the new line, as Emacs's electric-indent-mode does; on by default.",
  value: true,
});

/** The indentation of a line: the column its first character that is not a space or tab starts at. */
const lineIndentation = (line: number): number => e8.currentIndentation(e8.lineStart(line));

/** Gives a line an indentation, point kept with the text after it, as indent-line-to in save-excursion. */
function indentLineToColumn(line: number, column: number): void {
  e8.saveExcursion(() => {
    e8.gotoChar(e8.lineStart(line));
    e8.indentLineTo(column);
  });
}

/**
 * What electric-indent-mode does after RET where indentation is relative:
 * the spaces at the end of the line before go, and the new line is indented
 * like the line before it, or not at all after a blank one, as
 * indent-according-to-mode does for indent-relative.
 */
function electricIndentAfterNewline(): void {
  const line = e8.lineOf(e8.point());
  if (line === 0) return;
  // delete-horizontal-space backward from the end of the line before.
  const before = e8.lineEnd(line - 1);
  const text = e8.lineText(line - 1);
  const trailing = text.length - text.replace(/[ \t]+$/, "").length;
  if (trailing > 0) e8.deleteRegion(before - trailing, before);
  const column = /^[ \t]*$/.test(e8.lineText(line - 1)) ? 0 : lineIndentation(line - 1);
  const start = e8.lineStart(line);
  if (e8.point() - start <= (/^[ \t]*/.exec(e8.lineText(line))?.[0].length ?? 0)) {
    indentLineToColumn(line, column);
    e8.gotoChar(start + (/^[ \t]*/.exec(e8.lineText(line))?.[0].length ?? 0));
  } else indentLineToColumn(line, column);
}

e8.defineVariable({
  name: "electric-indent-chars",
  doc: "Characters that reindent the line when typed, with electric-indent-mode on: newline, and in code modes closing braces and parens.",
  value: ["\n"],
  local: true,
});
e8.defineVariable({
  name: "electric-indent-inhibit",
  doc: "Whether RET leaves the line it ends as it is, indenting only the new one, as modes where indentation is meaning set it.",
  value: false,
  local: true,
});

/**
 * What electric-indent-mode does after RET where the mode indents for
 * itself, as electric-indent-post-self-insert-function: reindents the line
 * ended, unless electric-indent-inhibit, takes its trailing whitespace off,
 * and indents the new line.
 */
function reindentAfterNewline(): void {
  const line = e8.lineOf(e8.point());
  if (line === 0) return;
  const here = e8.makeMarker(undefined, { advances: true });
  e8.gotoChar(e8.lineEnd(line - 1));
  if (e8.variable("electric-indent-inhibit") !== true) e8.call("indent-according-to-mode");
  const end = e8.lineEnd(line - 1);
  const text = e8.lineText(line - 1);
  const trailing = text.length - text.replace(/[ \t]+$/, "").length;
  if (trailing > 0) e8.deleteRegion(end - trailing, end);
  e8.gotoChar(e8.markerPosition(here)!);
  e8.deleteMarker(here);
  e8.call("indent-according-to-mode");
}

/** Whether indent-line-function only tabs, as those in indent-line-ignored-functions do. */
function indentsOnlyByTabbing(): boolean {
  const fn = e8.variable("indent-line-function");
  const ignored = e8.variable("indent-line-ignored-functions");
  return typeof fn !== "string" || (Array.isArray(ignored) && ignored.includes(fn));
}

/** Typing a closing brace or another of electric-indent-chars reindents its line. */
function electricIndentChar(): void {
  if (e8.variable("electric-indent-mode") !== true) return;
  const key = e8.lastKey();
  if (key === undefined || [...key].length !== 1) return;
  const chars = e8.variable("electric-indent-chars");
  if (!Array.isArray(chars) || !chars.includes(key) || indentsOnlyByTabbing()) return;
  const st = e8.syntaxPpss(Math.max(0, e8.point() - 1));
  if (st.inString !== null || st.inComment !== null) return;
  e8.call("indent-according-to-mode");
}
e8.addHook("post-self-insert-hook", electricIndentChar);

e8.defineCommand({
  name: "newline",
  doc:
    "Insert a newline, or as many as the prefix argument says.\n\n" +
    "Typed, with electric-indent-mode on, it also indents the new line as the mode says, as RET does in Emacs.",
  run: () => {
    const n = e8.prefixNumericValue();
    if (n < 0) throw new Error("Repetition argument has to be non-negative");
    e8.insertAndInherit("\n".repeat(n));
    // As self-insert does: Auto Fill mode fills the line the newline ends,
    // unless there is a prefix argument.
    const fill = e8.variable("auto-fill-function");
    if (typeof fill === "string" && e8.prefixArg() === null) {
      e8.gotoChar(e8.point() - 1);
      e8.call(fill as e8.CommandName);
      if (e8.point() < e8.bufferSize()) e8.gotoChar(e8.point() + 1);
    }
    // As electric-indent-post-self-insert-function, which runs late in
    // post-self-insert-hook, after Electric Pair mode's functions.
    const interactive = e8.calledInteractively();
    e8.runHooks("post-self-insert-hook");
    if (interactive && e8.variable("electric-indent-mode") === true) {
      // Where the mode's indenting only tabs, as indent-relative, the line
      // ended is left alone, as electric-indent-functions-without-reindent says.
      if (indentsOnlyByTabbing()) electricIndentAfterNewline();
      else reindentAfterNewline();
    }
  },
});

const electricNewline = e8.defineCommand({
  name: "electric-newline-and-maybe-indent",
  doc:
    "Insert a newline. With electric-indent-mode on, as it is by default, that is all; RET is the key " +
    "that indents.",
  run: () => e8.insertAndInherit("\n"),
});
e8.bindKey("C-j", electricNewline);

// Indirect buffers, as simple.el clones them.

/**
 * Makes an indirect buffer of the current one, in its major mode and with
 * its local variables, named as it is, without a <N> suffix, made unique,
 * and shows it if `display`, as clone-indirect-buffer.
 */
function cloneIndirectBuffer(newname: string | undefined, display: boolean): e8.Buffer {
  let name = newname ?? e8.bufferName();
  name = name.replace(/<[0-9]+>$/, "");
  const buffer = e8.makeIndirectBuffer(e8.currentBuffer(), e8.generateNewBufferName(name), true);
  if (display) e8.call("pop-to-buffer", buffer.name ?? "");
  return buffer;
}

for (const name of ["clone-indirect-buffer", "clone-indirect-buffer-other-window"] as const) {
  const command = e8.defineCommand({
    name,
    doc:
      "Make an indirect buffer of the current buffer and show it in another window: the same text, " +
      "with a point, narrowing and modes of its own.\n\n" +
      "With a prefix argument, ask for its name; otherwise it is named after the current buffer, made unique.",
    params: [{ name: "arg", kind: "prefix" }],
    run: async (arg) => {
      const named = arg === null ? undefined : await e8.readString("Name of indirect buffer: ", { default: e8.bufferName() });
      cloneIndirectBuffer(named === "" ? undefined : named, true);
    },
  });
  if (name === "clone-indirect-buffer-other-window") e8.bindKey("C-x 4 c", command);
}

// Shell commands, as simple.el's shell-command and shell-command-on-region:
// a command run by shell-file-name with -c, its output in the echo area if
// it fits on a line, else in *Shell Command Output*.

for (const [name, doc, value] of [
  ["shell-file-name", "The shell programs and shell commands are run with, from $SHELL.", e8.getenv("SHELL") ?? "/bin/sh"],
  ["shell-command-switch", "What tells the shell that the next argument is a command to run.", "-c"],
  ["shell-command-buffer-name", "The buffer shell commands' output goes into when it does not fit in the echo area.", "*Shell Command Output*"],
  ["shell-command-buffer-name-async", "The buffer the output of a command run with M-& goes into.", "*Async Shell Command*"],
] as const) {
  e8.defineVariable({ name, doc, value });
}

/** Runs a shell command with `input`, as call-shell-region: its exit code and output. */
function callShell(command: string, input?: string): { exit: number; output: string } {
  const shell = String(e8.variable("shell-file-name"));
  return e8.callProcess([shell, String(e8.variable("shell-command-switch")), command], { input, directory: e8.expandFileName(".") });
}

/**
 * Shows a command's output as display-message-or-buffer does: one line
 * in the echo area, more in the output buffer, shown.
 */
function showOutput(output: string, exit: number): void {
  const name = String(e8.variable("shell-command-buffer-name"));
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(0, e8.bufferSize());
      e8.insert(output);
    });
    e8.gotoChar(0);
    e8.setBufferModified(false);
  });
  if (output === "") {
    e8.message(exit === 0 ? "(Shell command succeeded with no output)" : `(Shell command failed with code ${exit} and no output)`);
    return;
  }
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  const shown = e8.windowList().some((w) => e8.windowBuffer(w) === name);
  // As many lines as the echo area may grow to, max-mini-window-height of the frame's.
  const max = Number(e8.variable("max-mini-window-height") ?? 0.25);
  const frameLines = e8.windowSize()?.totalHeight ?? 24;
  const fits = Number.isInteger(max) ? max : Math.max(1, Math.floor(frameLines * max));
  if (body.split("\n").length <= fits && !shown) e8.message(body);
  else e8.call("display-buffer", name);
}

/**
 * Runs a shell command with the region as its input, as
 * shell-command-on-region: the output replaces the region with
 * `replace`, point before it and the mark after, or else is shown.
 */
function shellCommandOnRegion(start: number, end: number, command: string, replace: boolean): number {
  const [from, to] = [Math.min(start, end), Math.max(start, end)];
  const { exit, output } = callShell(command, e8.bufferSubstringNoProperties(from, to));
  if (replace) {
    e8.deleteRegion(from, to);
    e8.gotoChar(from);
    e8.insert(output);
    e8.setMark(from + [...output].length);
    e8.gotoChar(from);
  } else {
    showOutput(output, exit);
  }
  return exit;
}

e8.defineCommand({
  name: "shell-command-on-region",
  doc:
    "Run a shell command with the region as its input, showing its output.\n\n" +
    "With a prefix argument, the output replaces the region instead.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "command", kind: "string", prompt: "Shell command on region: " },
    { name: "replace", kind: "prefix" },
  ],
  run: (start: number, end: number, command: string, replace: e8.PrefixArg) => {
    shellCommandOnRegion(start, end, command, replace !== null);
  },
});

e8.defineCommand({
  name: "shell-command",
  doc:
    "Run a shell command and show its output: in the echo area if it is one line, else in *Shell Command Output*.\n\n" +
    "A command ending in & runs in the background, as M-& does. With a prefix argument, the output goes into the " +
    "buffer at point, with the mark after it.",
  params: [
    { name: "command", kind: "string", prompt: "Shell command: " },
    { name: "arg", kind: "prefix" },
  ],
  run: (command: string, arg: e8.PrefixArg) => {
    if (/[ \t]*&[ \t]*$/.test(command)) {
      e8.call("async-shell-command", command.replace(/[ \t]*&[ \t]*$/, ""));
      return;
    }
    if (arg !== null) {
      if (e8.bufferReadOnly()) e8.signal("buffer-read-only", `Buffer is read-only: ${e8.bufferName()}`);
      const at = e8.point();
      const { output } = callShell(command);
      e8.insert(output);
      // Point before the output and the mark after it, as exchange-point-and-mark leaves them.
      e8.setMark(e8.point());
      e8.gotoChar(at);
      return;
    }
    shellCommandOnRegion(e8.point(), e8.point(), command, false);
  },
});

e8.bindKey("M-!", "shell-command");
e8.bindKey("M-|", "shell-command-on-region");

// Everyday editing commands from simple.el: indentation and spaces, blank
// lines, killing whole lines and up to a character, going to a line, and
// what is at point.

e8.defineCommand({
  name: "back-to-indentation",
  doc: "Move point to the first character on the line that is not a space or tab.",
  shiftSelect: true,
  run: () => {
    e8.gotoChar(e8.lineBeginningPosition());
    e8.skipSyntaxForward(" ", e8.lineEndPosition());
    // Back over characters with whitespace syntax and the prefix flag.
    e8.backwardPrefixChars();
  },
});
e8.bindKey("M-m", "back-to-indentation");

for (const [name, doc, dir] of [
  ["forward-to-indentation", "Move forward a line, or as many as the prefix argument says, to its first character that is not a space or tab.", 1],
  ["backward-to-indentation", "Move back a line, or as many as the prefix argument says, to its first character that is not a space or tab.", -1],
] as const) {
  e8.defineCommand({
    name,
    doc,
    shiftSelect: true,
    params: [{ name: "arg", kind: "count" }],
    run: (arg: number) => {
      forwardLine(dir * arg);
      e8.skipCharsForward(" \t");
    },
  });
}

/** Deletes the characters in `chars` around point, or only before it, as delete-space--internal. */
function deleteSpace(chars: string, backwardOnly: boolean): void {
  const orig = e8.point();
  let end = orig;
  if (!backwardOnly) {
    e8.skipCharsForward(chars);
    end = e8.constrainToField(e8.point(), orig, true);
  }
  e8.gotoChar(orig);
  e8.skipCharsBackward(chars);
  const start = e8.constrainToField(e8.point(), orig);
  e8.deleteRegion(start, end);
  e8.gotoChar(start);
}

e8.defineCommand({
  name: "delete-horizontal-space",
  doc: "Delete the spaces and tabs around point; with a prefix argument, only those before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => deleteSpace(" \t", arg !== null),
});
e8.bindKey("M-\\", "delete-horizontal-space");

e8.defineCommand({
  name: "delete-all-space",
  doc: "Delete the spaces, tabs and newlines around point; with a prefix argument, only those before it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => deleteSpace(" \t\r\n", arg !== null),
});

/** Leaves `n` spaces where there are spaces and tabs around point, newlines too if n is negative, as just-one-space. */
function justOneSpace(n = 1): void {
  const orig = e8.point();
  const skip = n < 0 ? " \t\n\r" : " \t";
  let num = Math.abs(n);
  e8.skipCharsBackward(skip);
  e8.gotoChar(e8.constrainToField(e8.point(), orig));
  num -= e8.skipCharsForward(" ", e8.point() + num);
  const mid = e8.point();
  e8.skipCharsForward(skip);
  const end = e8.constrainToField(e8.point(), orig, true);
  e8.deleteRegion(mid, end);
  e8.gotoChar(mid);
  e8.insert(" ".repeat(Math.max(0, num)));
}

e8.defineCommand({
  name: "just-one-space",
  doc: "Leave one space where there are spaces and tabs around point; with a prefix argument, that many, and newlines go too if it is negative.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => justOneSpace(n),
});

e8.defineVariable({
  name: "cycle-spacing-actions",
  doc: "What M-SPC does each time in a row: just-one-space, delete-all-space, delete-space-after, delete-space-before or restore.",
  value: ["just-one-space", "delete-all-space", "restore"],
});

/** What M-SPC started with: where point was, the space around it, the prefix argument, and what it did last. */
let cycleSpacing: { origPos: number; whitespace: string; n: e8.PrefixArg; last: string | undefined } | undefined;

e8.defineCommand({
  name: "cycle-spacing",
  doc:
    "Change the space around point, a different way each time in a row, as cycle-spacing-actions says: " +
    "first one space, then none, then as it was.\n\n" +
    "The prefix argument is the number of spaces, and when negative, newlines are deleted too.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n: e8.PrefixArg) => {
    const actions = (e8.variable("cycle-spacing-actions") ?? []) as string[];
    const same = (a: e8.PrefixArg, b: e8.PrefixArg) => JSON.stringify(a) === JSON.stringify(b);
    if (e8.lastCommand() !== "cycle-spacing" || cycleSpacing === undefined || (n !== null && !same(cycleSpacing.n, n))) {
      const orig = e8.point();
      const [start, end] = e8.saveExcursion(() => {
        e8.skipCharsBackward(" \t\n\r");
        const s = e8.constrainToField(e8.point(), orig);
        e8.gotoChar(s);
        e8.skipCharsForward(" \t\n\r");
        return [s, e8.constrainToField(e8.point(), orig, true)];
      });
      cycleSpacing = { origPos: orig, whitespace: e8.bufferSubstringNoProperties(start, end), n, last: undefined };
    }
    const context = cycleSpacing;
    const i = context.last === undefined ? 0 : actions.indexOf(context.last) + 1;
    const action = i < actions.length ? actions[i]! : actions[0]!;
    const restore = () => {
      deleteSpace(" \t\r\n", false);
      e8.insert(context.whitespace);
      e8.gotoChar(context.origPos);
    };
    restore();
    const numeric = e8.prefixNumericValue(context.n);
    const newlines = context.n === "-" || numeric < 0;
    const deleteSpaceDir = (count: number, forward: boolean) => {
      const orig = e8.point();
      const chars = newlines ? " \t\r\n" : " \t";
      const skip = (max?: number) =>
        forward
          ? e8.skipCharsForward(chars, max === undefined ? undefined : e8.point() + max)
          : e8.skipCharsBackward(chars, max === undefined ? undefined : e8.point() - max);
      if (count === 0 || count === Math.abs(skip(count))) {
        const start = e8.point();
        skip();
        const end = e8.point();
        if (start !== end) e8.deleteRegion(Math.min(start, end), Math.max(start, end));
        e8.gotoChar(forward ? orig : Math.min(start, end) + count);
      }
    };
    if (action === "just-one-space") justOneSpace(numeric);
    else if (action === "delete-space-after") deleteSpaceDir(context.n === "-" ? 0 : Math.abs(numeric), true);
    else if (action === "delete-space-before") deleteSpaceDir(context.n === "-" ? 0 : Math.abs(numeric), false);
    else if (action === "delete-all-space") deleteSpace(newlines ? " \t\r\n" : " \t", false);
    else if (action !== "restore") e8.funcall(action, context.n);
    context.last = action;
  },
});
e8.bindKey("M-SPC", "cycle-spacing");

e8.defineCommand({
  name: "fixup-whitespace",
  doc: "Leave one space or none around point, as the text on either side calls for.",
  run: () => {
    e8.saveExcursion(() => {
      deleteSpace(" \t", false);
      const none = e8.lookingAt("^\\|$\\|\\s)") || (e8.point() > e8.pointMin() && e8.lookingAt("$\\|\\s(\\|\\s'", e8.point() - 1));
      if (!none) e8.insert(" ");
    });
  },
});

e8.defineCommand({
  name: "delete-indentation",
  doc:
    "Join this line to the one before it, leaving one space or none between them; with a prefix argument, to the one after.\n\n" +
    "A fill prefix at the start of the joined line is deleted too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (arg !== null) forwardLine(1);
    e8.gotoChar(e8.lineBeginningPosition());
    if (e8.point() <= e8.pointMin()) return;
    const prefix = e8.variable("fill-prefix");
    e8.deleteRegion(e8.point() - 1, e8.point());
    if (typeof prefix === "string" && prefix !== "" && e8.bufferSubstringNoProperties(e8.point(), Math.min(e8.pointMax(), e8.point() + prefix.length)) === prefix) {
      e8.deleteRegion(e8.point(), e8.point() + prefix.length);
    }
    e8.call("fixup-whitespace");
  },
});
e8.bindKey("M-^", "delete-indentation");

e8.defineCommand({
  name: "delete-blank-lines",
  doc: "On a blank line, delete the blank lines around it but one; on a lone blank line, delete it; else delete the blank lines after this one.",
  run: () => {
    const [thisBlank, singleBlank] = e8.saveExcursion(() => {
      e8.gotoChar(e8.lineBeginningPosition());
      const blank = e8.lookingAt("[ \t]*$");
      const single =
        blank &&
        !e8.lookingAt("[ \t]*\n[ \t]*$") &&
        (e8.point() === e8.pointMin() || (forwardLine(-1), !e8.lookingAt("[ \t]*$")));
      return [blank, single];
    });
    if (thisBlank) {
      e8.gotoChar(e8.lineBeginningPosition());
      if (singleBlank) forwardLine(1);
      const from = e8.point();
      const to = e8.reSearchBackward("[^ \t\n]", { noerror: true }) !== undefined ? (forwardLine(1), e8.point()) : e8.pointMin();
      e8.deleteRegion(Math.min(from, to), Math.max(from, to));
      e8.gotoChar(Math.min(from, to));
    }
    if (!(thisBlank && singleBlank)) {
      e8.saveExcursion(() => {
        e8.gotoChar(e8.lineEndPosition());
        forwardLine(1);
        const from = e8.point();
        const to = e8.reSearchForward("[^ \t\n]", { noerror: true }) !== undefined ? e8.lineBeginningPosition() : e8.pointMax();
        e8.deleteRegion(from, to);
      });
    }
    // Just before a newline at the end of the buffer: delete that line.
    if (e8.lookingAt("^[ \t]*\n\\'")) e8.deleteRegion(e8.point(), e8.pointMax());
  },
});
e8.bindKey("C-x C-o", "delete-blank-lines");

e8.defineVariable({ name: "delete-trailing-lines", doc: "Whether delete-trailing-whitespace on the whole buffer deletes empty lines at its end too.", value: true });

e8.defineCommand({
  name: "delete-trailing-whitespace",
  doc:
    "Delete the spaces and tabs at the ends of lines, in the region if it is active, else in the whole buffer, " +
    "where empty lines at the end go too, as delete-trailing-lines says. Form feeds stay.",
  run: () => {
    const mark = e8.mark();
    const [start, end] = e8.regionActive() && mark !== undefined ? [Math.min(mark, e8.point()), Math.max(mark, e8.point())] : [undefined, undefined];
    e8.saveExcursion(() => {
      const endMarker = end === undefined ? undefined : e8.makeMarker(end);
      e8.gotoChar(start ?? e8.pointMin());
      // Whitespace syntax but a form feed, as the command's own syntax table has it.
      while (e8.reSearchForward("[ \t ]+$", { bound: endMarker === undefined ? undefined : e8.markerPosition(endMarker), noerror: true }) !== undefined) {
        const b = e8.matchBeginning(0)!;
        const e = e8.matchEnd(0)!;
        if (e8.getTextProperty(b, "read-only") === undefined) e8.deleteRegion(b, e);
        else e8.gotoChar(e);
      }
      if (endMarker !== undefined) {
        e8.deleteMarker(endMarker);
      } else if (e8.variable("delete-trailing-lines") !== false && e8.variable("delete-trailing-lines") !== null) {
        e8.gotoChar(e8.pointMax());
        if (e8.pointMax() === e8.bufferSize() && e8.skipCharsBackward("\n") <= -2) e8.deleteRegion(e8.point() + 1, e8.pointMax());
      }
    });
  },
});

e8.defineCommand({
  name: "kill-whole-line",
  doc:
    "Kill the line point is on, its newline too; with a prefix argument, that many lines, " +
    "back with the newline before them if negative, and with 0 the line without its newline.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const eobp = () => e8.point() === e8.pointMax();
    const bobp = () => e8.point() === e8.pointMin();
    if (arg > 0 && eobp() && e8.saveExcursion(() => (e8.gotoChar(e8.lineBeginningPosition()), eobp()))) e8.signal("end-of-buffer", "End of buffer");
    if (arg < 0 && bobp() && e8.saveExcursion(() => (e8.gotoChar(e8.lineEndPosition()), bobp()))) e8.signal("beginning-of-buffer", "Beginning of buffer");
    if (e8.lastCommand() !== "kill-region") {
      e8.killNew("");
      e8.setLastCommand("kill-region");
    }
    const begin = e8.makeMarker(e8.point());
    let region1End: e8.Marker;
    if (arg === 0) {
      region1End = e8.makeMarker(e8.lineBeginningPosition());
      e8.gotoChar(e8.lineEndPosition());
    } else if (arg < 0) {
      region1End = e8.makeMarker(e8.lineEndPosition());
      forwardLine(1 + arg);
      if (!bobp()) e8.gotoChar(e8.point() - 1);
    } else {
      region1End = e8.makeMarker(e8.lineBeginningPosition());
      e8.gotoChar(e8.lineBeginningPosition());
      forwardLine(arg);
    }
    const second = e8.point();
    const secondMarker = e8.makeMarker(second);
    e8.killRegion(e8.markerPosition(begin)!, e8.markerPosition(region1End)!);
    e8.setLastCommand("kill-region");
    e8.killRegion(e8.markerPosition(begin)!, e8.markerPosition(secondMarker)!);
    for (const m of [begin, region1End, secondMarker]) e8.deleteMarker(m);
    e8.setThisCommand("kill-region");
  },
});
e8.bindKey("C-S-DEL", "kill-whole-line");

/** The character a key types, as the key read stands for it: C-a is ^A, RET is ^M. Undefined for keys that are not characters. */
export function keyChar(key: string): string | undefined {
  const named: Record<string, string> = { SPC: " ", TAB: "\t", RET: "\r", ESC: "\x1b", DEL: "\x7f", "C-SPC": "\0", "C-@": "\0" };
  if (named[key] !== undefined) return named[key];
  if ([...key].length === 1) return key;
  const control = /^C-(.)$/.exec(key);
  if (control !== null) {
    const c = control[1]!;
    if (c === "?") return "\x7f";
    const code = c.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  }
  return undefined;
}

/** Kills to the arg'th `char`, and it too unless `upTo`, as zap-to-char and zap-up-to-char. */
function zap(arg: number, char: string, upTo: boolean): void {
  // Read interactively, an upper-case letter searches exactly.
  const fold = char.toLowerCase() !== char ? false : undefined;
  const p = e8.point();
  if (!upTo) {
    const m = e8.search(char, { backward: arg < 0, caseFold: fold });
    let found = m;
    for (let i = 1; found !== undefined && i < Math.abs(arg); i++) {
      e8.gotoChar(arg < 0 ? found.start : found.end);
      found = e8.search(char, { backward: arg < 0, caseFold: fold });
    }
    e8.gotoChar(p);
    if (found === undefined) e8.signal("search-failed", `Search failed: "${char}"`, [char]);
    e8.killRegion(p, arg < 0 ? found!.start : found!.end);
  } else {
    const direction = arg >= 0 ? 1 : -1;
    // Past a match right at point, as zap-up-to-char's forward-char does.
    const start = p + direction;
    if (start < e8.pointMin() || start > e8.pointMax()) e8.signal("search-failed", `Search failed: "${char}"`, [char]);
    e8.gotoChar(start);
    let found = e8.search(char, { backward: arg < 0, caseFold: fold });
    for (let i = 1; found !== undefined && i < Math.abs(arg); i++) {
      e8.gotoChar(arg < 0 ? found.start : found.end);
      found = e8.search(char, { backward: arg < 0, caseFold: fold });
    }
    e8.gotoChar(p);
    if (found === undefined) e8.signal("search-failed", `Search failed: "${char}"`, [char]);
    e8.killRegion(p, arg < 0 ? found!.end : found!.start);
  }
  e8.setThisCommand("kill-region");
}

e8.defineVariable({ name: "read-char-history", doc: "Characters read by zap-to-char and its kin, newest first.", value: [] });

for (const [name, doc, upTo] of [
  ["zap-to-char", "Kill up to and including the next occurrence of a character; with a prefix argument, the Nth, back if negative.", false],
  ["zap-up-to-char", "Kill up to, but not including, the next occurrence of a character; with a prefix argument, the Nth, back if negative.", true],
] as const) {
  e8.defineCommand({
    name,
    doc: `${doc}\n\nAn upper-case character is searched for exactly; others fold case as case-fold-search says.`,
    params: [{ name: "arg", kind: "count" }],
    run: async (arg: number) => {
      const char = keyChar(await e8.readChar(upTo ? "Zap up to char: " : "Zap to char: "));
      if (char === undefined) e8.userError("Non-character input-event");
      zap(arg, char!, upTo);
    },
  });
}
e8.bindKey("M-z", "zap-to-char");

e8.defineVariable({ name: "goto-line-history", doc: "Line numbers answered to goto-line, newest first.", value: [] });
e8.defineVariable({ name: "widen-automatically", doc: "Whether goto-line widens a narrowed buffer to go to a line outside it.", value: true });

/** The number at point, if there is one, as number-at-point finds it. */
function numberAtPoint(): number | undefined {
  const line = e8.bufferSubstringNoProperties(e8.lineBeginningPosition(), e8.lineEndPosition());
  const col = e8.point() - e8.lineBeginningPosition();
  for (const m of allMatches(/-?[0-9]+(?:\.[0-9]+)?/g, line)) {
    if (m.index! <= col && col <= m.index! + m[0].length) return Number(m[0]);
  }
  return undefined;
}

/** The line number of a position, counting from 1 at the start of the accessible text. */
const lineNumberAtPos = (pos = e8.point()): number =>
  e8.bufferSubstringNoProperties(e8.pointMin(), pos).split("\n").length;

e8.defineCommand({
  name: "goto-line",
  doc:
    "Go to a line, counting from 1 at the start of the buffer: the prefix argument's, else one asked for, " +
    "the number at point by default.\n\nThe mark is pushed first, unless the region is active. In a narrowed " +
    "buffer, a line outside it widens the buffer, as widen-automatically says.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: e8.PrefixArg) => {
    let line: number;
    if (arg !== null && !Array.isArray(arg)) {
      line = e8.prefixNumericValue(arg);
    } else {
      const n = numberAtPoint();
      const def = n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
      const narrowed = e8.bufferNarrowedP();
      const here = e8.saveRestriction(() => {
        e8.widen();
        return lineNumberAtPos();
      });
      const shown = def ?? here;
      const answer = await e8.readString(`Goto${narrowed ? " absolute" : ""} line (default ${shown}): `, { history: "goto-line-history" });
      line = answer.trim() === "" ? shown : Number(answer);
      if (!Number.isFinite(line)) e8.userError("Please enter a number.");
    }
    if (!e8.regionActive()) e8.pushMark(e8.point());
    const pos = e8.saveRestriction(() => {
      e8.widen();
      e8.gotoChar(e8.pointMin());
      forwardLine(line - 1);
      return e8.point();
    });
    if (e8.bufferNarrowedP() && e8.variable("widen-automatically") !== false && (pos < e8.pointMin() || pos > e8.pointMax())) e8.widen();
    e8.gotoChar(pos);
  },
});
e8.bindKey("M-g g", "goto-line");
e8.bindKey("M-g M-g", "goto-line");

e8.defineCommand({
  name: "goto-char",
  doc: "Go to a position in the buffer, counting characters from 1: the prefix argument's, else one asked for.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: e8.PrefixArg) => {
    const pos = arg !== null ? e8.prefixNumericValue(arg) : Number(await e8.readString(`Go to char (default ${e8.point() + 1}): `));
    e8.gotoChar(Math.max(e8.pointMin(), Math.min(e8.pointMax(), (Number.isFinite(pos) && pos > 0 ? pos : e8.point() + 1) - 1)));
  },
});
e8.bindKey("M-g c", "goto-char");

e8.defineCommand({
  name: "what-line",
  doc: "Say which line point is on, counting from the start of the buffer, and of the narrowing too if the buffer is narrowed.",
  run: () => {
    const n = lineNumberAtPos();
    if (e8.pointMin() === 0) {
      e8.message(`Line ${n}`);
      return;
    }
    const start = e8.pointMin();
    const whole = e8.saveRestriction(() => {
      e8.widen();
      return lineNumberAtPos(start);
    });
    e8.message(`line ${n + whole - 1} (narrowed line ${n})`);
  },
});

/** A key's description, as single-key-description writes a character. */
function charDescription(c: string): string {
  const code = c.codePointAt(0)!;
  if (code === 32) return "SPC";
  if (code === 9) return "TAB";
  if (code === 13) return "RET";
  if (code === 27) return "ESC";
  if (code === 127) return "DEL";
  if (code < 32) return `C-${String.fromCharCode(code + 96)}`;
  return c;
}

e8.defineCommand({
  name: "what-cursor-position",
  doc:
    "Say what character is after point, in decimal, octal and hex, and how the file writes it if it is not ASCII; " +
    "and where point is, as a position, a percentage of the buffer, and a column.",
  run: () => {
    const pos = e8.point() + 1;
    const total = e8.bufferSize();
    const [beg, end] = [e8.pointMin() + 1, e8.pointMax() + 1];
    const percent = Math.round((100 * (pos - 1)) / Math.max(1, total));
    const col = e8.currentColumn();
    const narrowed = beg !== 1 || end !== total + 1;
    if (pos === end) {
      e8.message(narrowed ? `point=${pos} of ${total} (${percent}%) <${beg}-${end}> column=${col}` : `point=${pos} of ${total} (EOB) column=${col}`);
      return;
    }
    const c = e8.bufferSubstringNoProperties(pos - 1, pos);
    const code = c.codePointAt(0)!;
    const num = `${code}, #o${code.toString(8)}, #x${code.toString(16)}`;
    let encoding = `(${num})`;
    const display = e8.charProperty(pos - 1, "display");
    if (code >= 0x10ff80) {
      encoding = `(${num}, raw-byte)`;
    } else if (display !== undefined && display !== null) {
      let to = e8.nextSingleCharPropertyChange(pos - 1, "display") ?? e8.pointMax();
      let under = "";
      if (to >= pos - 1 + 4) {
        under = "...";
        to = pos - 1 + 4;
      }
      under = e8.bufferSubstringNoProperties(pos - 1, to) + under;
      encoding = typeof display === "string" ? `(${num}, part of display "${under}"->"${display}")` : `(${num}, part of display "${under}")`;
    } else if (code >= 128) {
      const coding = String(e8.variable("buffer-file-coding-system") ?? "utf-8-unix");
      if (e8.unencodableCharPosition(pos - 1, pos, coding) === undefined) {
        const bytes = [...e8.encodeCodingString(c, coding)];
        encoding = `(${num}, file ${bytes.length > 1 ? "..." : bytes.map((b) => `#x${b.codePointAt(0)!.toString(16).toUpperCase()}`).join(" ")})`;
      }
    }
    const shown = code < 128 ? charDescription(c) : c;
    e8.message(
      narrowed
        ? `Char: ${code < 256 ? charDescription(c) : c} ${encoding} point=${pos} of ${total} (${percent}%) <${beg}-${end}> column=${col}`
        : `Char: ${shown} ${encoding} point=${pos} of ${total} (${percent}%) column=${col}`,
    );
  },
});
e8.bindKey("C-x =", "what-cursor-position");

/** How many words there are from start to end, as count-words from Lisp: across fields. */
export function countWords(start: number, end: number): number {
  return e8.letBind({ "inhibit-field-text-motion": true }, () =>
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.narrowToRegion(start, end);
        e8.gotoChar(e8.pointMin());
        let words = 0;
        for (;;) {
          const p = e8.point();
          e8.call("forward-word", 1);
          if (e8.point() === p) break;
          // forward-word-strictly fails at the end with no word left.
          if (!/\w/u.test(e8.bufferSubstringNoProperties(p, e8.point()))) break;
          words++;
        }
        return words;
      }),
    ),
  );
}

/** What count-words says of a stretch of text, as count-words--format. */
function countWordsFormat(what: string, start: number, end: number): string {
  const lines = countLines(start, end);
  const sentences = (e8.funcall("count-sentences", start, end) as number) ?? 0;
  const words = countWords(start, end);
  const chars = end - start;
  const s = (n: number) => (n === 1 ? "" : "s");
  return `${what} has ${lines} line${s(lines)}, ${sentences} sentence${s(sentences)}, ${words} word${s(words)}, and ${chars} character${s(chars)}`;
}

/** How many lines there are from start to end, as count-lines: a last line without a newline counts. */
export function countLines(start: number, end: number): number {
  const text = e8.bufferSubstringNoProperties(start, end);
  const newlines = text.split("\n").length - 1;
  return text === "" || text.endsWith("\n") ? newlines : newlines + 1;
}

const bufferFormat = () => countWordsFormat(e8.bufferNarrowedP() ? "Narrowed part of buffer" : "Buffer", e8.pointMin(), e8.pointMax());

e8.defineCommand({
  name: "count-words",
  doc:
    "Say how many lines, sentences, words and characters the buffer has, or the region if it is active; " +
    "with a prefix argument, the whole buffer's too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    const mark = e8.mark();
    const region = e8.regionActive() && mark !== undefined;
    const totals =
      arg !== null && (region || e8.bufferNarrowedP())
        ? e8.saveRestriction(() => {
            e8.widen();
            return countWordsFormat("; buffer in total", e8.pointMin(), e8.pointMax());
          })
        : "";
    const text = region ? countWordsFormat("Region", Math.min(mark!, e8.point()), Math.max(mark!, e8.point())) : bufferFormat();
    e8.message(text + totals);
  },
});

e8.defineCommand({
  name: "count-words-region",
  doc: "Say how many lines, sentences, words and characters the region has, whether or not it is active; with a prefix argument, the buffer's.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (arg !== null) {
      e8.message(bufferFormat());
      return;
    }
    const mark = e8.mark() ?? e8.point();
    e8.message(countWordsFormat("Region", Math.min(mark, e8.point()), Math.max(mark, e8.point())));
  },
});
e8.bindKey("M-=", "count-words-region");

e8.defineCommand({
  name: "mark-word",
  doc:
    "Set the mark at the end of the next word; with a prefix argument, that many words on.\n\n" +
    "Again, or with the region active, the mark moves a word further, away from point.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    const mark = e8.mark();
    if ((e8.lastCommand() === "mark-word" && mark !== undefined) || e8.regionActive()) {
      const n = arg !== null ? e8.prefixNumericValue(arg) : mark! < e8.point() ? -1 : 1;
      e8.setMark(e8.saveExcursion(() => {
        e8.gotoChar(mark!);
        e8.call("forward-word", n);
        return e8.point();
      }));
      return;
    }
    const to = e8.saveExcursion(() => {
      e8.call("forward-word", e8.prefixNumericValue(arg));
      return e8.point();
    });
    e8.pushMark(to, { activate: true });
  },
});
e8.bindKey("M-@", "mark-word");

e8.defineCommand({
  name: "split-line",
  doc:
    "Split the line at point, moving the rest of it down to the column it was at. " +
    "A fill prefix the line starts with goes on the new line too, unless there is a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    e8.skipCharsForward(" \t");
    const col = e8.currentColumn();
    const pos = e8.point();
    const fill = e8.variable("fill-prefix");
    const prefix = arg === null && typeof fill === "string" && fill !== "" ? fill : undefined;
    const has = prefix !== undefined && e8.bufferSubstringNoProperties(e8.lineBeginningPosition(), Math.min(e8.pointMax(), e8.lineBeginningPosition() + prefix.length)) === prefix;
    e8.insert("\n");
    if (has) e8.insertAndInherit(prefix!);
    e8.indentTo(col);
    e8.gotoChar(pos);
  },
});
e8.bindKey("C-M-o", "split-line");

e8.defineVariable({ name: "read-quoted-char-radix", doc: "The radix C-q reads a character code in: 8, 10 or 16.", value: 8 });

e8.defineCommand({
  name: "quoted-insert",
  doc:
    "Insert the next character typed, whatever it is, such as a control character; with a prefix argument, that many.\n\n" +
    "Octal digits, as read-quoted-char-radix says, give a character's code instead: the first other key ends them, " +
    "and is typed itself unless it is RET.",
  params: [{ name: "arg", kind: "count" }],
  run: async (arg: number) => {
    const radix = Number(e8.variable("read-quoted-char-radix") ?? 8);
    const digit = (k: string) => {
      const d = k.length === 1 ? parseInt(k, radix) : NaN;
      return Number.isNaN(d) ? undefined : d;
    };
    let key = await e8.readEvent();
    let code: number | undefined;
    let char: string | undefined;
    if (digit(key) !== undefined && e8.variable("overwrite-mode") !== "overwrite-mode-textual") {
      code = 0;
      while (digit(key) !== undefined) {
        code = code * radix + digit(key)!;
        key = await e8.readEvent();
      }
      if (key !== "RET") e8.unreadKeys(key);
      char = String.fromCodePoint(code);
    } else {
      char = keyChar(key);
    }
    if (char === undefined) e8.userError(`${key} is not a valid character`);
    for (let i = 0; i < arg; i++) e8.insertAndInherit(char!);
  },
});
e8.bindKey("C-q", "quoted-insert");

e8.defineCommand({
  name: "copy-region-as-kill",
  doc: "Put the region's text on the kill ring without deleting it, as if it had been killed.",
  // As M-w copies, joining a kill just before it.
  run: () => e8.call("kill-ring-save"),
});

e8.defineCommand({
  name: "append-next-kill",
  doc: "Make the next kill join onto the last one on the kill ring, as consecutive kills do.",
  run: () => {
    e8.setThisCommand("kill-region");
    e8.message("If the next command is a kill, it will append");
  },
});
e8.bindKey("C-M-w", "append-next-kill");

/** The ends of the sexp `arg` sexps away from point, as transpose-sexps-default-function. */
function transposeSexpsDefault(arg: number): [number, number] {
  const sexp = (): number =>
    e8.saveExcursion(() => {
      e8.callWithPrefix(arg, "forward-sexp");
      return e8.point();
    });
  const inSymbol =
    arg > 0 ? e8.lookingAt("\\sw\\|\\s_") : e8.point() > e8.pointMin() && e8.lookingAt("\\sw\\|\\s_", e8.point() - 1);
  if (inSymbol) {
    // Jumping over a symbol, perhaps from inside it.
    if (arg > 0) e8.skipSyntaxBackward("w_");
    else e8.skipSyntaxForward("w_");
    return [sexp(), e8.point()];
  }
  // Between sexps: a step back first, so either direction takes the same one.
  if (arg > 0) e8.skipSyntaxBackward(" .");
  else e8.skipSyntaxForward(" .");
  const there = sexp();
  for (;;) {
    const comment = e8.forwardComment(arg > 0 ? 1 : -1);
    const punctuation = arg > 0 ? e8.skipSyntaxForward(".") : e8.skipSyntaxBackward(".");
    if (!comment && punctuation === 0) break;
  }
  return [there, e8.point()];
}

e8.defineCommand({
  name: "transpose-sexps",
  doc:
    "Exchange the balanced expressions around point, leaving point after both.\n\n" +
    "With a prefix argument, move the one before point past that many; with 0, exchange those at point and the mark.",
  run: () =>
    e8.conditionCase(() => transposeSubr(transposeSexpsDefault, e8.prefixNumericValue(), true), {
      "scan-error": () => e8.userError("Not between two complete sexps"),
    }),
});
e8.bindKey("C-M-t", "transpose-sexps");

/** Turns runs of spaces from start to end into tabs where that keeps the columns, as tabify. */
export function tabifyRegion(start: number, end: number): void {
  const tabWidth = Number(e8.variable("tab-width") ?? 8);
  e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      // From the start of the line, so columns count right.
      e8.narrowToRegion(e8.lineBeginningPosition(start), end);
      e8.gotoChar(start);
      e8.letBind({ "indent-tabs-mode": true }, () => {
        while (e8.reSearchForward(String(e8.variable("tabify-regexp") ?? " [ \t]+"), { noerror: true }) !== undefined) {
          const endCol = e8.currentColumn();
          const beg = e8.matchBeginning(0)!;
          const begCol = e8.saveExcursion(() => {
            e8.gotoChar(beg);
            e8.skipCharsForward("\t");
            return e8.currentColumn();
          });
          if (Math.floor(endCol / tabWidth) !== Math.floor(begCol / tabWidth)) {
            e8.deleteRegion(beg, e8.point());
            e8.gotoChar(beg);
            e8.indentTo(endCol);
          }
        }
      });
    }),
  );
}

/** Turns the tabs from start to end into spaces, keeping the columns, as untabify. */
export function untabifyRegion(start: number, end: number): void {
  const c = e8.currentColumn();
  e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.narrowToRegion(e8.pointMin(), end);
      e8.gotoChar(start);
      for (let m = e8.search("\t"); m !== undefined; m = e8.search("\t")) {
        const tabBeg = m.start;
        e8.gotoChar(tabBeg);
        e8.skipCharsForward("\t");
        const column = e8.currentColumn();
        e8.deleteRegion(tabBeg, e8.point());
        e8.gotoChar(tabBeg);
        e8.letBind({ "indent-tabs-mode": false }, () => e8.indentTo(column));
      }
    }),
  );
  e8.moveToColumn(c);
}

/** The region, or the whole buffer with a prefix argument, as tabify's and untabify's interactive specs. */
function regionOrBuffer(arg: e8.PrefixArg): [number, number] {
  const mark = e8.mark();
  if (arg === null && mark === undefined) e8.userError("The mark is not set now, so there is no region");
  return arg !== null ? [e8.pointMin(), e8.pointMax()] : [Math.min(mark!, e8.point()), Math.max(mark!, e8.point())];
}

e8.defineCommand({
  name: "tabify",
  doc: "Turn runs of spaces in the region into tabs where that keeps the columns, or in the whole buffer with a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => tabifyRegion(...regionOrBuffer(arg)),
});
e8.defineVariable({ name: "tabify-regexp", doc: "The regexp for the spaces tabify turns into tabs where it can.", value: " [ \t]+" });

e8.defineCommand({
  name: "untabify",
  doc: "Turn the tabs in the region into spaces, keeping the columns, or in the whole buffer with a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => untabifyRegion(...regionOrBuffer(arg)),
});

/** Inserts the region's text in another buffer, as append-to-buffer and its kin: `how` says where. */
function regionToBuffer(buffer: string, start: number, end: number, how: "append" | "prepend" | "copy"): void {
  const from = e8.bufferName();
  e8.getBufferCreate(buffer);
  e8.withCurrentBuffer(buffer, () => {
    if (e8.bufferReadOnly()) e8.signal("buffer-read-only", `Buffer is read-only: ${buffer}`);
    const point = e8.point();
    // Windows showing the buffer with their point where text goes in follow it, as append-to-buffer moves them.
    const windows = e8.windowList().filter((w) => e8.windowBuffer(w) === buffer && e8.windowPoint(w) === point);
    if (how === "copy") {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      e8.saveExcursion(() => e8.insertBufferSubstring(from, start, end));
    } else if (how === "prepend") {
      e8.saveExcursion(() => e8.insertBufferSubstring(from, start, end));
    } else {
      e8.insertBufferSubstring(from, start, end);
      for (const w of windows) e8.setWindowPoint(w, e8.point());
    }
  });
}

for (const [name, doc, prompt, how] of [
  ["append-to-buffer", "Insert the region's text into another buffer at its point, which moves after it.", "Append to buffer: ", "append"],
  ["prepend-to-buffer", "Insert the region's text into another buffer at its point, which stays before it.", "Prepend to buffer: ", "prepend"],
  ["copy-to-buffer", "Replace another buffer's text with the region's.", "Copy to buffer: ", "copy"],
] as const) {
  e8.defineCommand({
    name,
    doc,
    params: [
      { name: "buffer", kind: "buffer", prompt },
      { name: "start", kind: "region-beginning" },
      { name: "end", kind: "region-end" },
    ],
    run: (buffer: string, start: number, end: number) => regionToBuffer(buffer, start, end, how),
  });
}

e8.defineCommand({
  name: "insert-buffer",
  doc: "Insert another buffer's text after point, leaving the mark after it.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Insert buffer: " }],
  run: (buffer: string) => {
    if (!e8.getBuffer(buffer)) throw new Error(`No such buffer: ${buffer}`);
    const [start, stop] = e8.withCurrentBuffer(buffer, () => [e8.pointMin(), e8.pointMax()] as const);
    const end = e8.saveExcursion(() => {
      e8.insertBufferSubstring(buffer, start, stop);
      return e8.point();
    });
    e8.pushMark(end);
  },
});

e8.defineVariable({ name: "buffer-quit-function", doc: "A function ESC ESC ESC calls to leave the buffer, if nothing else comes first.", value: null, local: true });

e8.defineCommand({
  name: "keyboard-escape-quit",
  doc:
    "Get out of what you are in: deactivate the region, or leave the minibuffer or a recursive edit, " +
    "or quit the buffer as buffer-quit-function says, or delete the other windows.",
  run: () => {
    if (e8.lastCommand() === "mode-exited") return;
    if (e8.regionActive()) e8.deactivateMark();
    else if (e8.minibufferDepth() > 0) e8.call("abort-recursive-edit");
    else if (e8.prefixArg() !== null) return;
    else if (e8.recursionDepth() > 0) e8.call("exit-recursive-edit");
    else if (typeof e8.variable("buffer-quit-function") === "string") e8.funcall(e8.variable("buffer-quit-function") as string);
    else if (e8.windowList().length > 1) e8.call("delete-other-windows");
    else if (e8.bufferName().startsWith(" *")) e8.call("bury-buffer");
  },
});
e8.bindKey("M-ESC ESC", "keyboard-escape-quit");

for (const [name, doc, region, word] of [
  ["upcase-dwim", "Upcase the region if it is active, else the word after point, as M-u does.", "upcase-region", "upcase-word"],
  ["downcase-dwim", "Downcase the region if it is active, else the word after point, as M-l does.", "downcase-region", "downcase-word"],
  ["capitalize-dwim", "Capitalize the region if it is active, else the word after point, as M-c does.", "capitalize-region", "capitalize-word"],
] as const) {
  e8.defineCommand({
    name,
    doc,
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.PrefixArg) => {
      const mark = e8.mark();
      if (e8.regionActive() && mark !== undefined) e8.call(region, Math.min(mark, e8.point()), Math.max(mark, e8.point()));
      else e8.callWithPrefix(arg ?? 1, word);
    },
  });
}

// Asking before killing a buffer, after simple.el: kill-buffer runs
// kill-buffer-query-functions, with the buffer current, and keeps it if any
// says no, as process-kill-buffer-query-function does for a buffer whose
// process still runs.

e8.defineHook(
  "kill-buffer-query-functions",
  "Functions kill-buffer calls, with the buffer to kill current, before killing it; if any returns nil, the buffer is kept.",
);

/** Asks before killing a buffer whose process still runs, as simple.el's process-kill-buffer-query-function. */
function processKillBufferQueryFunction(): boolean {
  const process = e8.getBufferProcess(e8.bufferName());
  return (
    process === undefined ||
    !["run", "stop", "open", "listen"].includes(e8.processStatus(process) ?? "") ||
    !e8.processQueryOnExitFlag(process) ||
    e8.yesOrNoP(`Buffer ${JSON.stringify(e8.bufferName())} has a running process; kill it? `)
  );
}

e8.defun("process-kill-buffer-query-function", processKillBufferQueryFunction);
e8.addHook("kill-buffer-query-functions", processKillBufferQueryFunction);
