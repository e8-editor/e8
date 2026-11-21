// Hiding blocks of code and comments, after Emacs's hideshow.el: in
// hs-minor-mode, C-c @ C-h hides the block point is in, C-c @ C-s shows it,
// C-c @ C-c toggles it, C-c @ C-M-h hides every top-level block and
// C-c @ C-M-s shows them all. A block is what a mode's start regexp begins
// and forward-sexp ends, as hs-special-modes-alist says for the mode; a
// hidden one keeps its first line and shows "..." after it.

import { forwardSexp } from "lisp";
import { countLines } from "simple";
import { PerBuffer, regexpQuote, truthy } from "subr";

e8.defineVariable({
  name: "hs-special-modes-alist",
  doc:
    "How hideshow finds blocks in a major mode: a list of [MODE, START, END, COMMENT-START, FORWARD-SEXP-FUNC, " +
    "ADJUST-BEG-FUNC, FIND-BLOCK-BEGINNING-FUNC, FIND-NEXT-BLOCK-FUNC, LOOKING-AT-BLOCK-START-P-FUNC]. START, END " +
    "and COMMENT-START are regexps; START can be [REGEXP, N] to start the block at the Nth group. What is left out " +
    "or nil is guessed: parens for blocks, comment-start for comments, forward-sexp to go over a block.",
  value: [
    ["c-mode", "{", "}", "/[*/]", null, null],
    ["c-ts-mode", "{", "}", "/[*/]", null, null],
    ["c++-mode", "{", "}", "/[*/]", null, null],
    ["c++-ts-mode", "{", "}", "/[*/]", null, null],
    ["bibtex-mode", ["@\\S(*\\(\\s(\\)", 1]],
    ["java-mode", "{", "}", "/[*/]", null, null],
    ["java-ts-mode", "{", "}", "/[*/]", null, null],
    ["js-mode", "{", "}", "/[*/]", null],
    ["js-ts-mode", "{", "}", "/[*/]", null],
    ["lua-ts-mode", "{\\|\\[\\[", "}\\|\\]\\]", "--", null],
    ["mhtml-mode", "{\\|<[^/>]*?", "}\\|</[^/>]*[^/]>", "<!--", "mhtml-forward", null],
  ],
});

e8.defineVariable({
  name: "hs-hide-comments-when-hiding-all",
  doc: "Whether hs-hide-all hides comments of more than one line too.",
  value: true,
});
e8.defineVariable({
  name: "hs-allow-nesting",
  doc: "Whether showing a block keeps the blocks inside it that were hidden hidden.",
  value: null,
});
e8.defineVariable({
  name: "hs-set-up-overlay",
  doc: "A function called with each overlay hideshow makes to hide text, which can give it a display of its own.",
  value: null,
});
e8.defineVariable({
  name: "hs-isearch-open",
  doc: "Which hidden blocks isearch opens when search-invisible is open: code, comment, t for both, or nil for neither.",
  value: "code",
});
// Isearch shows a block its match is in while it is there, and for good
// where it ends, as hs-isearch-show-temporary and hs-isearch-show.
e8.defun("hs-isearch-show", (ov: e8.Value) => e8.deleteOverlay(Number(ov)));
e8.defun("hs-isearch-show-temporary", (overlay: e8.Value, hideP: e8.Value) => {
  const ov = Number(overlay);
  if (truthy(hideP)) {
    const saved = e8.overlayGet(ov, "hs-isearch-display");
    if (truthy(saved)) {
      e8.overlayPut(ov, "display", saved!);
      e8.overlayPut(ov, "hs-isearch-display", null);
    }
  } else {
    const display = e8.overlayGet(ov, "display");
    if (truthy(display)) {
      e8.overlayPut(ov, "hs-isearch-display", display!);
      e8.overlayPut(ov, "display", null);
    }
  }
  e8.overlayPut(ov, "invisible", truthy(hideP) ? "hs" : null);
});
e8.defineHook("hs-hide-hook", "Run at the end of the commands that hide blocks.");
e8.defineHook("hs-show-hook", "Run at the end of the commands that show blocks.");

/** A function a mode's entry names, or the one hideshow uses without it. */
type Fn = e8.Value | (() => unknown);

/** What hideshow knows of a buffer's mode, as hs-grok-mode-type sets it. */
interface Settings {
  blockStart: string;
  /** The group of blockStart the block starts at. */
  select: number;
  blockEnd: string;
  commentStart: string;
  forwardSexp: Fn;
  adjustBeginning: Fn;
  findBeginning: Fn;
  findNext: Fn;
  atBlockStart: Fn;
}

const settings = new PerBuffer<Settings>();

function current(): Settings {
  const s = settings.get(e8.currentBuffer());
  if (!s) e8.signal("error", "Hideshow is not on in this buffer");
  return s;
}

/** Calls a function of a mode's entry, or hideshow's own. */
function call(fn: Fn, ...args: e8.Value[]): e8.Value {
  if (typeof fn === "function") return (fn as (...a: e8.Value[]) => e8.Value)(...args);
  return e8.funcall(fn as string, ...args);
}

const inStringOrComment = (pos = e8.point()): boolean => e8.syntaxPpss(pos).start !== null;

/** As looking-back without a limit: where a match of `re` ending at point starts. */
function lookingBack(re: string): number | undefined {
  return e8.saveExcursion(() => e8.reSearchBackward(`\\(?:${re}\\)\\=`, { noerror: true }) ?? undefined);
}

/** Where the last block start matched starts, the group the mode names. */
let blockStartAt = 0;
/** Where the last block start matched ends. */
let blockStartEnd = 0;

/** Whether point is at a block's start, outside strings and comments, as hs-looking-at-block-start-p. */
function lookingAtBlockStart(): boolean {
  const s = current();
  if (!e8.lookingAt(s.blockStart, undefined, { caseFold: true })) return false;
  noteMatch(s);
  return !inStringOrComment();
}

/** Remembers where the match just made starts and ends, as the match data hs-forward-sexp is given. */
function noteMatch(s: Settings): void {
  blockStartAt = e8.matchBeginning(s.select) ?? e8.matchBeginning(0)!;
  blockStartEnd = e8.matchEnd(0)!;
}

/** Whether point is at a block's start, by the mode's function, noting where its match is. */
function atBlockStart(): boolean {
  const s = current();
  if (!truthy(call(s.atBlockStart))) return false;
  noteMatch(s);
  return true;
}

/** Goes from the block start last matched over the block, as hs-forward-sexp. */
function forwardBlock(): void {
  const s = current();
  e8.gotoChar(blockStartAt);
  call(s.forwardSexp, 1);
}

function hsOverlayAt(pos: number): number | undefined {
  return e8.overlaysAt(pos).find((o) => truthy(e8.overlayGet(o, "hs")));
}

/** Deletes hideshow's overlays from `from` to `to`, as hs-discard-overlays. */
function discardOverlays(from: number, to: number): void {
  if (to < from) [from, to] = [to, from];
  if (truthy(e8.variable("hs-allow-nesting"))) {
    let pos = from;
    while (pos < to) {
      const o = hsOverlayAt(pos);
      if (o !== undefined) {
        pos = e8.overlayEnd(o) ?? pos + 1;
        e8.deleteOverlay(o);
      } else pos = e8.nextOverlayChange(pos);
    }
    return;
  }
  for (const o of e8.overlaysIn(from, to)) if (truthy(e8.overlayGet(o, "hs"))) e8.deleteOverlay(o);
}

/** An overlay hiding `b` to `e`, of kind "code" or "comment", as hs-make-overlay. */
function makeOverlay(b: number, e: number, kind: string, bOffset = 0, eOffset = 0): number {
  const o = e8.makeOverlay(b, e, { invisible: "hs", hs: kind, "hs-b-offset": bOffset, "hs-e-offset": eOffset });
  const open = e8.variable("hs-isearch-open");
  if (open === true || open === kind || (open === "block" && kind === "code")) {
    e8.overlayPut(o, "isearch-open-invisible", "hs-isearch-show");
    e8.overlayPut(o, "isearch-open-invisible-temporary", "hs-isearch-show-temporary");
  }
  const setUp = e8.variable("hs-set-up-overlay");
  if (truthy(setUp)) e8.funcall(setUp as string, o);
  return o;
}

/** Hides the comment from `beg` to `end`, as hs-hide-comment-region. */
function hideCommentRegion(beg: number, end: number, reposEnd = false): void {
  const goal = e8.currentColumn();
  const begBol = e8.lineBeginningPosition(beg);
  const begEol = e8.lineEndPosition(beg);
  const endEol = e8.lineEndPosition(end);
  discardOverlays(begEol, endEol);
  makeOverlay(begEol, endEol, "comment", beg, end);
  e8.gotoChar(reposEnd ? end : Math.min(end, begBol + goal));
}

/** Hides the block point is at the start of, or the comment given, as hs-hide-block-at-point. */
function hideBlockAtPoint(end = false, comment?: [number | undefined, number]): void {
  if (comment) {
    hideCommentRegion(comment[0]!, comment[1], end);
    return;
  }
  const s = current();
  if (!atBlockStart()) return;
  const headerEnd = blockStartEnd;
  const p = e8.lineEndPosition(Number(call(s.adjustBeginning, headerEnd)));
  forwardBlock();
  const q = lookingBack(s.blockEnd) ?? e8.point();
  if (p < q && countLines(p, q) > 1) {
    const nesting = truthy(e8.variable("hs-allow-nesting"));
    const ov = nesting ? hsOverlayAt(p) : undefined;
    if (ov !== undefined) e8.deleteOverlay(ov);
    else if (!nesting) discardOverlays(p, q);
    makeOverlay(p, q, "code", headerEnd - p);
  }
  e8.gotoChar(end ? q : Math.min(p, headerEnd));
}

/**
 * The comment point is in, as hs-inside-comment-p: its start and end, the
 * start undefined where something other than space comes before it on its
 * first line, so it cannot be hidden. Undefined if point is in none.
 */
function insideComment(): [number | undefined, number] | undefined {
  const s = current();
  return e8.saveExcursion(() => {
    const q = e8.point();
    e8.skipCharsForward(" \t");
    if (!e8.lookingAt(s.commentStart) && e8.reSearchBackward(s.commentStart, { noerror: true }) == null) return undefined;
    // To the start of this comment, then back over those before it.
    while (e8.point() > e8.pointMin()) {
      const at = e8.point();
      e8.forwardComment(-1);
      if (e8.point() !== at) break;
      e8.gotoChar(at - 1);
    }
    e8.forwardComment(-e8.bufferSize());
    e8.skipCharsForward(" \t\n\f");
    let p = e8.point();
    let hideable = true;
    e8.gotoChar(e8.lineBeginningPosition());
    if (!e8.lookingAt(`[ \t]*${s.commentStart}`)) {
      // Something comes before the comment on its line: on to the next
      // comment that has only space before it.
      e8.gotoChar(p);
      e8.forwardComment(1);
      e8.skipCharsForward(" \t\n\f");
      p = e8.point();
      while (e8.point() < q && e8.point() > p && !e8.lookingAt(s.commentStart)) {
        p = e8.point();
        e8.forwardComment(1);
        e8.skipCharsForward(" \t\n\f");
      }
      if (!e8.lookingAt(s.commentStart) || e8.point() > q) hideable = false;
    }
    e8.forwardComment(e8.bufferSize());
    e8.skipCharsBackward(" \t\n\f");
    e8.gotoChar(e8.lineEndPosition());
    return e8.point() >= q ? [hideable ? p : undefined, e8.point()] : undefined;
  });
}

/** Goes to the start of the block point is in, as hs-find-block-beginning: where, or undefined. */
function findBlockBeginning(): number | undefined {
  const s = current();
  const here = e8.point();
  if (atBlockStart()) return e8.point();
  while (e8.reSearchBackward(s.blockStart, { noerror: true, caseFold: true }) != null) {
    noteMatch(s);
    if (inStringOrComment()) continue;
    const [at, end] = [blockStartAt, blockStartEnd];
    const blockEnd = e8.saveExcursion(() => {
      forwardBlock();
      return e8.point();
    });
    [blockStartAt, blockStartEnd] = [at, end];
    if (here < blockEnd) return e8.point();
  }
  e8.gotoChar(here);
  return undefined;
}

/** Goes to the next block start before `maxp`, past comments unless `comments`, as hs-find-next-block. */
function findNextBlock(regexp: string, maxp: number, comments: boolean): boolean {
  if (!comments) e8.forwardComment(e8.bufferSize());
  return e8.point() < maxp && e8.reSearchForward(regexp, { bound: maxp, noerror: true, caseFold: true }) != null;
}

/** As hs-hide-level-recursive: hides the blocks `arg` levels in from `minp` to `maxp`. */
function hideLevelRecursive(arg: number, minp: number, maxp: number): void {
  const s = current();
  if (call(s.findBeginning) != null) {
    minp = e8.point() + 1;
    call(s.forwardSexp, 1);
    maxp = e8.point() - 1;
  }
  if (!truthy(e8.variable("hs-allow-nesting"))) discardOverlays(minp, maxp);
  e8.gotoChar(minp);
  while (truthy(call(s.findNext, s.blockStart, maxp, false))) {
    noteMatch(s);
    if (inStringOrComment()) continue;
    if (arg > 1) hideLevelRecursive(arg - 1, minp, maxp);
    else {
      e8.gotoChar(blockStartAt);
      hideBlockAtPoint(true);
    }
  }
  e8.gotoChar(maxp);
}

/** Goes to the end of the start of the block point is in, as hs-find-block-beginning-match. */
function findBlockBeginningMatch(): number | undefined {
  const s = current();
  if (call(s.findBeginning) != null && atBlockStart()) {
    e8.gotoChar(blockStartEnd);
    return e8.point();
  }
  return undefined;
}

/** The overlay hiding the block point is in, as hs-already-hidden-p. */
function alreadyHidden(): number | undefined {
  return e8.saveExcursion(() => {
    const comment = insideComment();
    if (comment && comment[0] !== undefined) e8.gotoChar(comment[0]);
    else if (!comment) {
      e8.gotoChar(e8.lineEndPosition());
      if (findBlockBeginningMatch() === undefined) {
        // Right after a hidden block counts as in it.
        e8.gotoChar(e8.lineBeginningPosition());
        findBlockBeginningMatch();
      }
    }
    return hsOverlayAt(e8.lineEndPosition());
  });
}

/** Sets up hideshow for the buffer's major mode, as hs-grok-mode-type. */
function grokModeType(): void {
  const commentStart = e8.variable("comment-start");
  if (typeof commentStart !== "string" || commentStart === "" || e8.variable("comment-end") == null) {
    e8.signal("error", `${e8.formatModeLine(Symbol.for("mode-name"))} Mode doesn't support Hideshow Minor Mode`);
  }
  const alist = e8.variable("hs-special-modes-alist");
  const lookup = (Array.isArray(alist) ? alist : []).find((e) => Array.isArray(e) && e[0] === e8.variable("major-mode")) as e8.Value[] | undefined;
  const nth = (n: number): e8.Value | undefined => (lookup && truthy(lookup[n]) ? lookup[n] : undefined);
  const start = nth(1) ?? "\\s(";
  settings.set(e8.currentBuffer(), {
    blockStart: Array.isArray(start) ? String(start[0]) : String(start),
    select: Array.isArray(start) ? Number(start[1]) : 0,
    blockEnd: lookup && typeof lookup[2] === "string" ? lookup[2] : "\\s)",
    commentStart: String(nth(3) ?? regexpQuote(commentStart.replace(/ +$/, ""))),
    forwardSexp: nth(4) ?? ((n: number) => forwardSexp(n)),
    adjustBeginning: nth(5) ?? ((p: number) => p),
    findBeginning: nth(6) ?? findBlockBeginning,
    findNext: nth(7) ?? findNextBlock,
    atBlockStart: nth(8) ?? lookingAtBlockStart,
  });
}

/** Runs `fn` with hs-minor-mode on, as hs-life-goes-on: does nothing otherwise. */
function lifeGoesOn(fn: () => void): void {
  if (truthy(e8.variable("hs-minor-mode"))) fn();
}

const hideAll = e8.defineCommand({
  name: "hs-hide-all",
  doc: "Hide every top-level block, leaving its first line showing, and with hs-hide-comments-when-hiding-all its comments too.",
  run: () =>
    lifeGoesOn(() => {
      const s = current();
      const comments = truthy(e8.variable("hs-hide-comments-when-hiding-all"));
      e8.saveExcursion(() => {
        if (!truthy(e8.variable("hs-allow-nesting"))) discardOverlays(e8.pointMin(), e8.pointMax());
        e8.gotoChar(e8.pointMin());
        const re = `\\(${s.blockStart}\\)${comments ? `\\|\\(${s.commentStart}\\)` : ""}`;
        while (truthy(call(s.findNext, re, e8.pointMax(), comments))) {
          if (e8.matchBeginning(1) !== undefined) {
            e8.gotoChar(e8.matchBeginning(1)!);
            const before = e8.point();
            hideBlockAtPoint(true);
            // Past the match, so a block that cannot be hidden is not found again.
            if (e8.point() === before && e8.lookingAt(s.blockStart, undefined, { caseFold: true })) e8.gotoChar(e8.matchEnd(0)!);
          } else {
            const comment = insideComment();
            if (comment && comment[0] !== undefined) {
              if (countLines(comment[0], comment[1]) > 1) hideBlockAtPoint(true, comment);
              else e8.gotoChar(comment[1]);
            }
          }
        }
      });
      e8.gotoChar(e8.lineBeginningPosition());
      e8.runHooks("hs-hide-hook");
    }),
});

const showAll = e8.defineCommand({
  name: "hs-show-all",
  doc: "Show every block hideshow hid.",
  run: () =>
    lifeGoesOn(() => {
      e8.message("Showing all blocks ...");
      e8.letBind({ "hs-allow-nesting": null }, () => discardOverlays(e8.pointMin(), e8.pointMax()));
      e8.message("Showing all blocks ... done");
      e8.runHooks("hs-show-hook");
    }),
});

const hideBlock = e8.defineCommand({
  name: "hs-hide-block",
  doc: "Hide the block or comment point is in, leaving its first line. With a prefix argument, leave point after it.",
  params: [{ name: "end", kind: "prefix" }],
  run: (end) =>
    lifeGoesOn(() => {
      const s = current();
      const comment = insideComment();
      if (comment && (comment[0] === undefined || countLines(comment[0], comment[1]) <= 1)) {
        e8.message("(not enough comment lines to hide)");
      } else if (comment || atBlockStart() || call(s.findBeginning) != null) {
        hideBlockAtPoint(truthy(end), comment);
        e8.runHooks("hs-hide-hook");
      }
    }),
});

const showBlock = e8.defineCommand({
  name: "hs-show-block",
  doc: "Show the block or comment point is in. With a prefix argument, leave point after it.",
  params: [{ name: "end", kind: "prefix" }],
  run: (end) =>
    lifeGoesOn(() => {
      const s = current();
      // First what is hidden at the end of the line.
      const ov = hsOverlayAt(e8.lineEndPosition());
      if (ov !== undefined) {
        const here = e8.point();
        e8.gotoChar(
          truthy(end)
            ? e8.overlayEnd(ov)!
            : e8.overlayGet(ov, "hs") === "comment"
              ? here
              : e8.overlayStart(ov)! + Number(e8.overlayGet(ov, "hs-b-offset") ?? 0),
        );
        e8.deleteOverlay(ov);
      } else {
        const comment = insideComment();
        let p: number | undefined;
        let q: number | undefined;
        if (comment) {
          if (comment[0] !== undefined) [p, q] = comment;
        } else if (call(s.findBeginning) != null && atBlockStart()) {
          p = e8.point();
          forwardBlock();
          q = e8.point();
        }
        if (p !== undefined && q !== undefined) {
          discardOverlays(p, q);
          e8.gotoChar(truthy(end) ? q : p + 1);
        }
      }
      e8.runHooks("hs-show-hook");
    }),
});

const hideLevel = e8.defineCommand({
  name: "hs-hide-level",
  doc: "Hide the blocks a level in from the block point is in, or as many levels as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) =>
    lifeGoesOn(() => {
      e8.saveExcursion(() => {
        e8.message("Hiding blocks ...");
        hideLevelRecursive(arg, e8.pointMin(), e8.pointMax());
        e8.message("Hiding blocks ... done");
      });
      e8.runHooks("hs-hide-hook");
    }),
});

const toggleHiding = e8.defineCommand({
  name: "hs-toggle-hiding",
  doc: "Hide the block point is in if it shows, else show it.",
  run: () =>
    lifeGoesOn(() => {
      if (alreadyHidden() !== undefined) e8.call(showBlock);
      else e8.call(hideBlock);
    }),
});

e8.defineCommand({
  name: "hs-hide-initial-comment-block",
  doc: "Hide the comment at the start of the file, if it has more than one line.",
  run: () =>
    lifeGoesOn(() => {
      const comment = e8.saveExcursion(() => {
        e8.gotoChar(e8.pointMin());
        e8.skipCharsForward(" \t\n\f");
        return insideComment();
      });
      if (comment && comment[0] !== undefined && countLines(comment[0], comment[1]) > 1) hideCommentRegion(comment[0], comment[1]);
    }),
});

const hsMinorMode = e8.defineMinorMode({
  name: "hs-minor-mode",
  lighter: " hs",
  doc:
    "Hide and show blocks of code and comments: C-c @ C-h hides the block point is in, C-c @ C-s shows it, C-c @ C-c " +
    "toggles it, C-c @ C-M-h hides all top-level blocks, C-c @ C-M-s shows them all and C-c @ C-l hides a level in.",
  bindings: {
    "C-c @ C-h": hideBlock,
    "C-c @ C-s": showBlock,
    "C-c @ C-M-h": hideAll,
    "C-c @ C-M-s": showAll,
    "C-c @ C-l": hideLevel,
    "C-c @ C-c": toggleHiding,
    "C-c @ C-a": showAll,
    "C-c @ C-t": hideAll,
    "C-c @ C-d": hideBlock,
    "C-c @ C-e": toggleHiding,
  },
  onChange: (enabled) => {
    if (enabled) {
      try {
        grokModeType();
      } catch (e) {
        e8.setVariable("hs-minor-mode", false);
        throw e;
      }
      e8.addHook("change-major-mode-hook", turnOff, { local: true });
      e8.makeLocalVariable("line-move-ignore-invisible");
      e8.setVariable("line-move-ignore-invisible", true);
      e8.addToInvisibilitySpec("hs", { ellipsis: true });
    } else {
      e8.removeFromInvisibilitySpec("hs");
      discardOverlays(e8.pointMin(), e8.pointMax());
      settings.delete(e8.currentBuffer());
    }
  },
});

/** Turns hs-minor-mode off, as turn-off-hideshow does when the major mode changes. */
function turnOff(): void {
  e8.callWithPrefix(-1, hsMinorMode);
}
