// Spell checking as you type, after Emacs's flyspell.el: flyspell-mode
// checks each word as you leave it, underlining what the spell checker
// does not know and words written twice; C-. and M-TAB cycle through
// corrections of the word at point, C-; corrects the misspelling before
// point, C-, goes to the next and C-c $ offers corrections to choose from.
// flyspell-prog-mode checks only comments and strings.
//
// Copyright (C) 1998-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import {
  type Poss,
  acceptBufferLocalDefs,
  acceptForSession,
  acceptInBuffer,
  addPerFileWordList,
  changeDictionary,
  checkWords,
  insertPersonal,
  ispellWord,
  setSpellcheckerParams,
  wordAt as getWord,
} from "ispell";
import { PerBuffer, regexpQuote } from "subr";

e8.defineFace({ name: "flyspell-incorrect", doc: "Misspelled words.", attributes: { underline: { style: "wave", color: "Red1" } } });
e8.defineFace({ name: "flyspell-duplicate", doc: "Words written twice in a row.", attributes: { underline: { style: "wave", color: "DarkOrange" } } });

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("flyspell-default-dictionary", null, "The dictionary flyspell-mode starts with when neither ispell-local-dictionary nor ispell-dictionary names one.");
defvar("flyspell-delay", 3, "How many seconds of quiet after typing in a word before it is checked, rather than when you leave it.");
defvar("flyspell-mark-duplications-flag", true, "Whether a word written twice in a row is marked.");
defvar("flyspell-case-fold-duplications", true, "Whether words written twice count when their case differs.");
defvar("flyspell-duplicate-distance", 400000, "How far apart, in characters, a misspelling seen twice is marked as a duplicate rather than wrong; -1 for anywhere.");
defvar("flyspell-issue-message-flag", true, "Whether flyspell says what it is doing.");
defvar("flyspell-issue-welcome-flag", true, "Whether turning flyspell-mode on says how to correct words.");
defvar("flyspell-large-region", 1000, "Regions bigger than this, in characters, are checked in one run of the spell checker.");
defvar("flyspell-prog-text-faces", ["font-lock-string-face", "font-lock-comment-face", "font-lock-doc-face"], "The faces of text flyspell-prog-mode checks.");
e8.defineVariable({ name: "flyspell-generic-check-word-predicate", value: null, local: true, doc: "A function that says whether the word before point is to be checked, as flyspell-prog-mode sets." });
defvar("flyspell-delayed-commands", ["self-insert-command", "delete-backward-char", "backward-or-forward-delete-char", "delete-char", "backward-delete-char-untabify"], "Commands after which the word is checked only after flyspell-delay seconds of quiet.");
// Wheel and trackpad scrolling are deplacement as scroll-up and scroll-down
// are: point moves only to stay in the window, and checking a word on
// every step of a scroll made scrolling a long file lag. Emacs's list
// predates mwheel-scroll, which calls scroll-up and scroll-down.
defvar("flyspell-deplacement-commands", ["next-line", "previous-line", "scroll-up", "scroll-down", "scroll-up-command", "scroll-down-command", "mwheel-scroll", "scroll-up-line", "scroll-down-line"], "Commands after which the word is checked only if the command before was another.");
e8.defineHook("flyspell-incorrect-hook", "Functions called with the start, end and corrections of a misspelling before it is marked; one that returns true stops it being marked.");
e8.defineHook("flyspell-prog-mode-hook", "Functions called when flyspell-prog-mode starts.");

const truthy = (v: e8.Value | undefined): boolean => v !== null && v !== false && v !== undefined;
const listOf = (name: string): string[] => {
  const v = e8.variable(name);
  return Array.isArray(v) ? v.map(String) : [];
};

// Marking words.

const isFlyspell = (o: number): boolean => e8.overlayGet(o, "flyspell-overlay") === true;

/** Takes flyspell's marks off a position, as flyspell-unhighlight-at. */
function unhighlightAt(pos: number): void {
  for (const o of e8.overlaysAt(pos)) if (isFlyspell(o)) e8.deleteOverlay(o);
}
e8.defun("flyspell-unhighlight-at", (pos: number) => unhighlightAt(pos));

/** The buffer whose dictionary and words the spelling session last took up. */
let lastBuffer: number | undefined;

/** Takes up the buffer's dictionary and words when it is not the last one checked, as flyspell-accept-buffer-local-defs. */
function acceptLocalDefs(force = false): void {
  const id = e8.currentBuffer().id;
  if (force || lastBuffer !== id) {
    lastBuffer = id;
    acceptBufferLocalDefs();
  }
}

/** Marks a word as misspelled or doubled, as flyspell-highlight-incorrect-region. */
function highlight(start: number, end: number, poss: Poss | "doublon"): void {
  if (truthy(e8.runHookWithArgsUntilSuccess("flyspell-incorrect-hook", start, end, poss === "doublon" ? "doublon" : null))) return;
  if (start + 1 < end) for (const o of e8.overlaysIn(start + 1, end)) if (isFlyspell(o)) e8.deleteOverlay(o);
  unhighlightAt(start);
  e8.makeOverlay(start, end, {
    face: poss === "doublon" ? "flyspell-duplicate" : "flyspell-incorrect",
    "mouse-face": "highlight",
    "flyspell-overlay": true,
    evaporate: true,
    "help-echo": "mouse-2: correct word at point",
  }, { frontAdvance: true });
}

/** Where `word` is, whole, in [bound, point), nearest first, as flyspell-word-search-backward. */
function searchBackward(word: string, bound: number, ignoreCase = false): number | undefined {
  return e8.saveExcursion(() => {
    const re = `\\(?:[^[:alpha:]]\\|\\\`\\)${regexpQuote(word)}[^[:alpha:]]`;
    const limit = bound > e8.pointMin() ? bound - 1 : undefined;
    for (;;) {
      if (e8.reSearchBackward(re, { bound: limit, noerror: true, caseFold: ignoreCase }) === undefined) return undefined;
      if (e8.point() !== e8.pointMin()) e8.gotoChar(e8.point() + 1);
      const p = e8.point();
      const found = getWord();
      if (found && (ignoreCase ? found.word.toLowerCase() === word.toLowerCase() : found.word === word)) return p;
      e8.gotoChar(p);
    }
  });
}

/** Where `word` is, whole, after point, before bound, as flyspell-word-search-forward. */
function searchForward(word: string, bound: number): number | undefined {
  return e8.saveExcursion(() => {
    const re = `[^[:alpha:]]${regexpQuote(word)}\\(?:[^[:alpha:]]\\|\\'\\)`;
    const limit = bound < e8.pointMax() ? bound + 1 : undefined;
    for (;;) {
      if (e8.reSearchForward(re, { bound: limit, noerror: true }) === undefined) return undefined;
      if (e8.point() !== e8.pointMax()) e8.gotoChar(e8.point() - 1);
      const p = e8.point();
      const found = getWord();
      if (found?.word === word) return p;
      e8.gotoChar(p + 1);
    }
  });
}

/** The last word checked and what the checker said, as flyspell-word-cache-start, -end, -word and -result. */
const cache = new PerBuffer<{ start: number; end: number; word: string; result: boolean }>();

/**
 * Checks the word before point, or the one after with `following`, marking
 * it if it is wrong or doubled, as flyspell-word: true if it is right. A
 * known answer from the checker, `given`, saves asking it again.
 */
export function flyspellWord(following = false, given?: Poss): boolean {
  if (given === undefined) acceptLocalDefs();
  return e8.saveExcursion(() => {
    const found = getWord(following);
    if (found === undefined) return true;
    const predicate = e8.variable("flyspell-generic-check-word-predicate");
    if (truthy(predicate) && !e8.saveExcursion(() => {
      e8.gotoChar(found.end);
      return truthy(e8.funcall(predicate as string, []));
    })) return true;
    const { word, start, end } = found;
    // A word written twice in a row is marked before anything is asked.
    if (truthy(e8.variable("flyspell-mark-duplications-flag"))) {
      const gap = e8.saveExcursion(() => {
        e8.gotoChar(start);
        return -e8.skipCharsBackward(" \t\n\f");
      });
      const bound = start - (end - start) - gap;
      const p = bound >= e8.pointMin()
        ? e8.saveExcursion(() => {
          e8.gotoChar(start);
          return searchBackward(word, bound, truthy(e8.variable("flyspell-case-fold-duplications")));
        })
        : undefined;
      if (p !== undefined && p !== start) {
        highlight(start, end, "doublon");
        return false;
      }
    }
    const cached = cache.get(e8.currentBuffer());
    if (given === undefined && cached && cached.start === start && cached.end === end && cached.word === word) return cached.result;
    const poss = given ?? checkWords([word])[0];
    const right = poss === true || typeof poss === "string" || poss === undefined;
    cache.set(e8.currentBuffer(), { start, end, word, result: right });
    if (right) {
      unhighlightAt(start);
      if (end > start) unhighlightAt(end - 1);
      return true;
    }
    // A misspelling seen again nearby is marked as a duplicate.
    const distance = Number(e8.variable("flyspell-duplicate-distance") ?? 0);
    const before = e8.saveExcursion(() => {
      e8.gotoChar(start);
      return searchBackward(word, distance < 0 ? e8.pointMin() : start - distance);
    });
    const after = before !== undefined ? undefined : e8.saveExcursion(() => {
      e8.gotoChar(end);
      return searchForward(word, distance < 0 ? e8.pointMax() : end + distance);
    });
    if (distance !== 0 && (before !== undefined || after !== undefined)) {
      highlight(start, end, "doublon");
      return false;
    }
    let hstart = start;
    let hend = end;
    if (Array.isArray(poss)) {
      hstart = start + poss[1] - 1;
      if (hstart < start) hstart = start;
      hend = hstart + [...poss[0]].length;
    }
    highlight(hstart, hend, poss);
    return false;
  });
}

// Checking as you type.

const state = new PerBuffer<{ prePoint?: number; preColumn?: number; prePrePoint?: number; previous?: string; changes: [number, number][]; timer?: number }>();
const stateOf = () => {
  let s = state.get(e8.currentBuffer());
  if (!s) {
    s = { changes: [] };
    state.set(e8.currentBuffer(), s);
  }
  return s;
};

const isWordChar = (pos: number): boolean => /[\p{L}']/u.test(e8.charAfter(pos) ?? "");

function preCommand(): void {
  const s = stateOf();
  s.prePoint = e8.point();
  s.preColumn = e8.currentColumn();
}

/** Whether the word point was at before the command is to be checked now, as flyspell-check-pre-word-p. */
function checkPreWordP(command: string | undefined): boolean {
  const s = stateOf();
  const pre = s.prePoint;
  if (pre === undefined) return false;
  if (s.prePrePoint === pre) return false;
  const point = e8.point();
  if ((pre === point - 1 && isWordChar(pre)) || pre === point || pre === point + 1) return false;
  if (command !== undefined && !e8.executingKbdMacro()) {
    const delayed = listOf("flyspell-delayed-commands").includes(command);
    const deplacement = listOf("flyspell-deplacement-commands").includes(command) && s.previous === command;
    const col = e8.currentColumn();
    if ((delayed || deplacement) && (col === 0 || col === s.preColumn || e8.charAfter(pre) === undefined || isWordChar(pre))) return false;
  }
  const c = cache.get(e8.currentBuffer());
  if (!c) return true;
  return pre < c.start || pre > c.end;
}

/** Whether the word at point is to be checked now, as flyspell-check-word-p: else after a pause, for a delayed command. */
function checkWordP(command: string | undefined): boolean | "later" {
  const s = stateOf();
  if (e8.pointMax() - 1 <= e8.pointMin()) return false;
  const col = e8.currentColumn();
  if (col > 0 && col !== s.preColumn) {
    const before = e8.charAfter(e8.point() - 1) ?? "";
    if (!/\p{L}/u.test(before) && before !== "'" && before !== "-") return true;
  }
  if (command === undefined) return true;
  if (listOf("flyspell-deplacement-commands").includes(command)) return s.previous !== command;
  if (listOf("flyspell-delayed-commands").includes(command)) return "later";
  return true;
}

function postCommand(): void {
  if (!truthy(e8.variable("flyspell-mode"))) return;
  const s = stateOf();
  const command = e8.thisCommand();
  if (s.timer !== undefined) {
    e8.cancelTimer(s.timer);
    s.timer = undefined;
  }
  if (command === "transpose-chars" && s.prePoint !== undefined) {
    e8.saveExcursion(() => {
      e8.gotoChar(s.prePoint! - 1);
      flyspellWord();
    });
  }
  if (checkPreWordP(command)) {
    e8.saveExcursion(() => {
      e8.gotoChar(Math.min(s.prePoint!, e8.pointMax()));
      flyspellWord();
    });
  }
  const now = checkWordP(command);
  if (now === true) {
    flyspellWord();
    s.prePrePoint = e8.point();
  } else {
    s.prePrePoint = undefined;
    if (now === "later") {
      // As sit-for flyspell-delay: the word is checked once typing pauses.
      const buffer = e8.currentBuffer();
      const at = e8.point();
      s.timer = e8.runWithIdleTimer(Number(e8.variable("flyspell-delay") ?? 3), false, () => {
        s.timer = undefined;
        if (!e8.bufferLiveP(buffer)) return;
        e8.withCurrentBuffer(buffer, () => {
          if (e8.point() === at && truthy(e8.variable("flyspell-mode"))) flyspellWord();
        });
      });
      cache.delete(e8.currentBuffer());
    }
  }
  // The words changes touched, as flyspell-after-change-function records them.
  const point = e8.point();
  for (const [start, stop] of s.changes) {
    const space = /[\n ]/.test(e8.charAfter(start) ?? "") && stop > start;
    const near = s.prePoint !== undefined && ((s.prePoint >= start && s.prePoint <= stop) || point >= start || point <= stop || point === stop + 1);
    if (space || !near) {
      e8.saveExcursion(() => {
        e8.gotoChar(Math.min(start, e8.pointMax()));
        flyspellWord();
      });
    }
  }
  s.changes = [];
  s.previous = command;
}

function afterChange(start: number, stop: number): void {
  stateOf().changes.push([start, stop]);
}

export const flyspellMode = e8.defineMinorMode({
  name: "flyspell-mode",
  lighter: " Fly",
  doc:
    "Check spelling as you type: a word you leave is checked, and underlined if the spell checker does not know it, " +
    "or if it is written twice. C-. or M-TAB cycles through corrections of the word at point, C-; corrects the " +
    "misspelling before point, C-, goes to the next one and C-c $ offers corrections to choose from. " +
    "M-x flyspell-buffer checks the whole buffer.",
  bindings: {
    "C-M-i": "flyspell-auto-correct-word",
    "C-;": "flyspell-auto-correct-previous-word",
    "C-,": "flyspell-goto-next-error",
    "C-.": "flyspell-auto-correct-word",
    "C-c $": "flyspell-correct-word-before-point",
  },
  onChange: (enabled) => {
    if (enabled) {
      e8.conditionCase(
        () => {
          setSpellcheckerParams();
          e8.setVariable("ispell-highlight-face", e8.intern("flyspell-incorrect"));
          const fallback = e8.variable("flyspell-default-dictionary");
          if (!truthy(e8.variable("ispell-local-dictionary")) && !truthy(e8.variable("ispell-dictionary")) && typeof fallback === "string") {
            changeDictionary(fallback);
          }
          // Taken up now, or a dictionary the buffer names could be missed.
          acceptLocalDefs(true);
        },
        { error: (e) => e8.message(`Error enabling Flyspell mode:\n${e.message}`) },
      );
      e8.addHook("hack-local-variables-hook", hackLocalVariables, { local: true, depth: 90 });
      e8.addHook("pre-command-hook", preCommand, { local: true });
      e8.addHook("post-command-hook", postCommand, { local: true });
      e8.addHook("after-change-functions", afterChange, { local: true });
      if (truthy(e8.variable("flyspell-issue-message-flag")) && truthy(e8.variable("flyspell-issue-welcome-flag")) && e8.thisCommand() === "flyspell-mode") {
        e8.message("Welcome to Flyspell. Use ‘C-M-i’ or ‘Mouse-2’ to correct words.");
      }
    } else {
      e8.removeHook("hack-local-variables-hook", hackLocalVariables, { local: true });
      e8.removeHook("pre-command-hook", preCommand, { local: true });
      e8.removeHook("post-command-hook", postCommand, { local: true });
      e8.removeHook("after-change-functions", afterChange, { local: true });
      for (const o of e8.overlaysIn(e8.pointMin(), e8.pointMax())) if (isFlyspell(o)) e8.deleteOverlay(o);
      state.delete(e8.currentBuffer());
    }
  },
});

/** Takes up the buffer's dictionary again once its local variables are set, as flyspell-hack-local-variables-hook. */
function hackLocalVariables(): void {
  acceptLocalDefs(true);
}

e8.defun("turn-on-flyspell", () => e8.callWithPrefix(1, flyspellMode));
e8.defun("turn-off-flyspell", () => e8.callWithPrefix(-1, flyspellMode));

/** Whether the word before point is in a comment or string, as flyspell-generic-progmode-verify. */
e8.defun("flyspell-generic-progmode-verify", () => {
  if (e8.point() === e8.pointMin()) return false;
  const face = e8.getTextProperty(e8.point() - 1, "face");
  // Tree-sitter's faces are not text properties in E8: without one, the
  // syntax state says whether the word is in a comment or string.
  if (face === undefined || face === null) {
    const ppss = e8.syntaxPpss(e8.point() - 1);
    return ppss.inString !== null || ppss.inComment !== null;
  }
  const faces = listOf("flyspell-prog-text-faces");
  return (Array.isArray(face) ? face.map(String) : [String(face)]).some((f) => faces.includes(f));
});

e8.defineCommand({
  name: "flyspell-prog-mode",
  doc: "Turn flyspell-mode on for comments and strings only.",
  run: () => {
    e8.makeLocalVariable("flyspell-generic-check-word-predicate");
    e8.setVariable("flyspell-generic-check-word-predicate", "flyspell-generic-progmode-verify");
    e8.callWithPrefix(1, flyspellMode);
    e8.runHooks("flyspell-prog-mode-hook");
  },
});

// Checking regions.

/** Checks every word in a region, asking the checker once, as flyspell-large-region does. */
function flyspellRegion(beg: number, end: number): void {
  if (beg === end) return;
  [beg, end] = [Math.min(beg, end), Math.max(beg, end)];
  acceptLocalDefs();
  const verbose = truthy(e8.variable("flyspell-issue-message-flag"));
  if (verbose) e8.message("Checking region...");
  e8.saveExcursion(() => {
    const words: { word: string; end: number }[] = [];
    e8.gotoChar(beg);
    while (e8.point() < end) {
      const found = getWord(true);
      if (found === undefined || found.start >= end) break;
      words.push({ word: found.word, end: found.end });
      e8.gotoChar(Math.max(found.end, e8.point() + 1));
    }
    const unique = [...new Set(words.map((w) => w.word))];
    const answers = new Map<string, Poss>();
    checkWords(unique).forEach((poss, i) => answers.set(unique[i], poss));
    for (const w of words) {
      e8.gotoChar(w.end);
      flyspellWord(false, answers.get(w.word));
    }
  });
  if (verbose) e8.message("Spell Checking completed.");
}

e8.defineCommand({
  name: "flyspell-region",
  doc: "Check the spelling of every word in the region, underlining the misspellings.",
  params: [{ name: "start", kind: "region-beginning" }, { name: "end", kind: "region-end" }],
  run: (start: number, end: number) => flyspellRegion(start, end),
});
e8.defineCommand({
  name: "flyspell-buffer",
  doc: "Check the spelling of every word in the buffer, underlining the misspellings.",
  run: () => flyspellRegion(e8.pointMin(), e8.pointMax()),
});

// Going to and correcting misspellings.

let lastError: { buffer: string; pos: number } | undefined;

e8.defineCommand({
  name: "flyspell-goto-next-error",
  doc: "Go to the next word flyspell marked; with a prefix argument, the one before. After the last, start again from the top.",
  params: [{ name: "previous", kind: "prefix" }],
  run: (previous: e8.PrefixArg) => {
    const back = previous !== null;
    let pos = e8.point();
    const max = back ? e8.pointMin() : e8.pointMax();
    if (lastError && lastError.buffer === e8.bufferName() && lastError.pos === pos) {
      if (pos === max) {
        e8.message(back ? "Restarting from end of the buffer" : "Restarting from beginning of buffer");
        e8.gotoChar(back ? e8.pointMax() : e8.pointMin());
      } else e8.call(back ? "backward-word" : "forward-word", 1);
      pos = e8.point();
    }
    while (pos !== max && !e8.overlaysAt(pos).some(isFlyspell)) pos += back ? -1 : 1;
    e8.gotoChar(pos);
    if (back) e8.call("backward-word", 1);
    lastError = { buffer: e8.bufferName(), pos: e8.point() };
    if (e8.point() === max) e8.message("No more miss-spelled words");
  },
});

/**
 * Where the last auto-correction was, the ring of corrections and the
 * word as it was at its end, and which is in, as flyspell-auto-correct-region
 * and -ring.
 */
let autoCorrect: { pos: number; start: number; length: number; ring: string[]; at: number } | undefined;

/**
 * Says which corrections come next, as flyspell-display-next-corrections:
 * the ring goes round, so it is written out until the line is full.
 */
function displayNextCorrections(first: string[], ring: string[], at: number): void {
  let text = "Corrections:";
  for (const w of first) text += ` ${w}`;
  for (let i = at; text.length < 80; i++) text += ` ${ring[i % ring.length]}`;
  e8.message(text);
}

/** Moves point back where it was, shifted by what the correction changed, as flyspell-adjust-cursor-point. */
function adjustCursor(save: number, cursor: number, oldMax: number): void {
  if (save >= cursor) e8.gotoChar(Math.min(Math.max(save + e8.pointMax() - oldMax, e8.pointMin()), e8.pointMax()));
  else e8.gotoChar(save);
}

/** Replaces the word at point with its first correction, or the next if called again, as flyspell-auto-correct-word. */
function autoCorrectWord(following = false): void {
  acceptLocalDefs();
  const pos = e8.point();
  const oldMax = e8.pointMax();
  const last = e8.lastCommand();
  if (last !== "flyspell-auto-correct-word" && last !== "flyspell-auto-correct-previous-word") autoCorrect = undefined;
  if (autoCorrect && autoCorrect.pos === pos) {
    const { start, length } = autoCorrect;
    unhighlightAt(start);
    e8.deleteRegion(start, start + length);
    const { ring } = autoCorrect;
    autoCorrect.at = (autoCorrect.at + 1) % ring.length;
    const word = ring[autoCorrect.at];
    e8.gotoChar(start);
    e8.insert(word);
    autoCorrect.length = [...word].length;
    flyspellWord();
    displayNextCorrections([], ring, autoCorrect.at);
    adjustCursor(pos, e8.point(), oldMax);
    autoCorrect.pos = e8.point();
    return;
  }
  const found = getWord(following);
  if (found === undefined) return;
  const { word, start, end } = found;
  const [poss] = checkWords([word]);
  if (poss === undefined) e8.signal("error", "Ispell: error in Ispell process");
  if (!Array.isArray(poss)) return;
  const replacements = poss[2];
  autoCorrect = undefined;
  if (replacements.length === 0 || replacements[0] === poss[0]) return;
  const fresh = replacements[0];
  // The ring comes back round to the word as it was.
  const ring = [...replacements, poss[0]];
  unhighlightAt(start);
  e8.deleteRegion(start, end);
  e8.gotoChar(start);
  e8.insert(fresh);
  autoCorrect = { pos: 0, start, length: [...fresh].length, ring, at: 0 };
  flyspellWord();
  displayNextCorrections([fresh], ring, 0);
  adjustCursor(pos, e8.point(), oldMax);
  autoCorrect.pos = e8.point();
}

e8.defineCommand({
  name: "flyspell-auto-correct-word",
  doc: "Replace the word at point with its first correction; again, with the next, and so round to the word as it was.",
  run: () => autoCorrectWord(),
});

e8.defineCommand({
  name: "flyspell-auto-correct-previous-word",
  doc: "Correct the nearest misspelling before point that the window shows, as C-. corrects the word at point; again, with the next correction.",
  params: [{ name: "position", kind: "point" }],
  run: (position: number) => {
    const top = e8.windowStart();
    const misspelt = e8.overlaysIn(top, position)
      .filter((o) => isFlyspell(o) && e8.overlayGet(o, "face") === "flyspell-incorrect")
      .sort((a, b) => e8.overlayStart(b)! - e8.overlayStart(a)!);
    const at = autoCorrect && e8.lastCommand() === "flyspell-auto-correct-previous-word" ? autoCorrect.start : misspelt.length > 0 ? e8.overlayStart(misspelt[0]) : undefined;
    if (at === undefined) return;
    e8.saveExcursion(() => {
      e8.gotoChar(at);
      if (autoCorrect) autoCorrect.pos = at;
      autoCorrectWord(true);
      if (autoCorrect) autoCorrect.pos = at;
    });
  },
});

e8.defineCommand({
  name: "flyspell-correct-word-before-point",
  doc:
    "Offer corrections for the misspelled word before point to choose from, with Save word to add it to your " +
    "dictionary, Accept (session) to accept it until E8 quits, and Accept (buffer) to accept it in this file.",
  run: () => {
    acceptLocalDefs();
    const opoint = e8.point();
    const found = getWord();
    if (found === undefined) return;
    const { word, start, end } = found;
    const [poss] = checkWords([word]);
    if (poss === undefined) e8.signal("error", "Ispell: error in Ispell process");
    if (!Array.isArray(poss)) return;
    const choices = [...poss[2], "Save word", "Accept (session)", "Accept (buffer)"];
    const answer = e8.completingRead(`Correct ${word}: `, choices, { requireMatch: true });
    if (answer === "Save word") {
      insertPersonal(word);
      unhighlightAt(opoint);
    } else if (answer === "Accept (session)" || answer === "Accept (buffer)") {
      acceptForSession(word);
      acceptInBuffer(word);
      unhighlightAt(opoint);
      if (answer === "Accept (buffer)") addPerFileWordList(word);
    } else if (answer !== "" && answer !== poss[0]) {
      const oldMax = e8.pointMax();
      unhighlightAt(opoint);
      e8.deleteRegion(start, end);
      e8.gotoChar(start);
      e8.insert(answer);
      adjustCursor(opoint, opoint + [...word].length - (end - start), oldMax);
    } else e8.gotoChar(opoint);
  },
});

e8.defineCommand({
  name: "flyspell-check-previous-highlighted-word",
  doc: "Offer corrections for the nearest misspelling flyspell marked before point, as M-$ does for the word at point.",
  run: () => {
    const marked = e8.overlaysIn(e8.pointMin(), e8.point()).filter(isFlyspell).sort((a, b) => e8.overlayStart(b)! - e8.overlayStart(a)!);
    if (marked.length === 0) e8.signal("error", "No word to correct before point");
    e8.saveExcursion(() => {
      e8.gotoChar(e8.overlayStart(marked[0])!);
      ispellWord(true);
      cache.delete(e8.currentBuffer());
      flyspellWord(true);
    });
  },
});

// A session ended forgets what the checker said, as flyspell-kill-ispell-hook.
e8.addHook("ispell-kill-ispell-hook", () => {
  lastBuffer = undefined;
  cache.clear();
});
