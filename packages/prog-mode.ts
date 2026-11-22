// The mode programming modes are built on, after Emacs's prog-mode.el.

import { defineGuide } from "help-guide";
import { composeRegion } from "composite";
import { defineGlobalizedMinorMode } from "subr";
import { indentRegionBetween } from "indent";

e8.defineMajorMode({
  name: "prog-mode",
  modeName: "Prog",
  doc:
    "The major mode programming language modes are built on.\n\n" +
    "Put what you want in every programming mode on prog-mode-hook, which runs before each mode's own hook.",
  // As prog-mode.el: source files end in a newline.
  setup: () => e8.setVariable("require-final-newline", e8.variable("mode-require-final-newline") ?? true),
});

const progFillReindentDefun = e8.defineCommand({
  name: "prog-fill-reindent-defun",
  doc:
    "Fill the paragraph of the comment or string point is in, or that starts later on its line; else indent the function point is in or before.\n\n" +
    "A prefix argument justifies the paragraph, as fill-paragraph's does.",
  params: [{ name: "argument", kind: "prefix" }],
  run: (argument: e8.PrefixArg) => {
    e8.saveExcursion(() => {
      // In a string or a comment, or before one on the line, as syntax-ppss and \s< find them.
      if (e8.syntaxPpss(e8.point()).start !== null || e8.reSearchForward("\\s-*\\s<", { bound: e8.lineEndPosition(), noerror: true }) !== undefined) {
        e8.callWithPrefix(argument, "fill-paragraph");
        return;
      }
      e8.call("beginning-of-defun");
      const start = e8.point();
      e8.call("end-of-defun");
      indentRegionBetween(start, e8.point());
    });
  },
});
e8.bindKey("M-q", progFillReindentDefun, "prog-mode-map");

// What C-h h shows in a programming mode, which takes it as its own unless it gives one (ADR 0068).
defineGuide("prog-mode", {
  title: "Prog mode",
  summary: "The mode every programming language's mode is built on, with the keys they share.",
  keys: [
    [
      "Writing code",
      [
        ["indent-for-tab-command", "Indent the line, or complete what is before point"],
        ["completion-at-point", "Complete the name before point"],
        ["comment-dwim", "Comment the selection out, or add a comment to the line"],
      ],
    ],
    [
      "Finding your way",
      [
        ["xref-find-definitions", "Go to the definition of the name at point"],
        ["xref-go-back", "Come back from it"],
        ["xref-find-references", "List where the name is used"],
        ["beginning-of-defun", "Go to the start of the function"],
        ["forward-sexp", "Move over a balanced expression: brackets, a string"],
      ],
    ],
    [
      "The project",
      [
        ["project-find-file", "Open a file of the project, by name"],
        ["project-find-regexp", "Search every file of the project"],
        ["compile", "Build or test it; the errors become links"],
        ["next-error", "Go to the next error or match"],
      ],
    ],
  ],
  tryNow: [
    "Put point on a function's name and press \\[xref-find-definitions], then \\[xref-go-back] to come back.",
    "Select a few lines and press \\[comment-dwim] to comment them out; again to bring them back.",
  ],
  learnNext: [
    "\\[eglot] starts a language server, when one is installed, for completion and errors as you type.",
    "\\[describe-mode] lists every key of the mode you are in.",
  ],
});

// Prettify Symbols mode: showing symbols such as `lambda` as `λ`, through
// compositions (composite.ts), as prog-mode.el's prettify-symbols-mode.

e8.defineVariable({
  name: "prettify-symbols-alist",
  doc:
    "The symbols Prettify Symbols mode shows as other characters, as [symbol, character] pairs: " +
    "the character a code point or a string, or characters and composition rules alternating.",
  value: [["lambda", 955]],
  local: true,
});
e8.defineVariable({
  name: "prettify-symbols-compose-predicate",
  doc:
    "The function that says whether a symbol found from start to end is shown prettily, called with start, end and the symbol; " +
    "by default, unless it is part of a longer word or symbol, or in a string or comment.",
  value: "prettify-symbols-default-compose-p",
  local: true,
});
e8.defineVariable({
  name: "prettify-symbols-unprettify-at-point",
  doc: "Whether a symbol is shown as itself while point is on it: null, true, or right-edge to count point just after it too. E8 does not look at it yet.",
  value: null,
});

/** Whether a symbol found from start to end stands alone, outside strings and comments, as prettify-symbols-default-compose-p. */
function defaultComposeP(start: number, end: number): boolean {
  const syntax = (pos: number) => e8.charSyntax(e8.charAfter(pos) ?? " ");
  const wordy = (cls: string) => cls === "w" || cls === "_";
  const sameKind = (a: string, b: string) => (wordy(a) ? wordy(b) : b === "." || b === "\\");
  const before = start > e8.pointMin() ? syntax(start - 1) : " ";
  const after = end < e8.pointMax() ? syntax(end) : " ";
  if (sameKind(syntax(start), before) || sameKind(syntax(end - 1), after)) return false;
  const state = e8.syntaxPpss(end);
  return state.inString === null && state.inComment === null;
}
e8.defun("prettify-symbols-default-compose-p", (start: number, end: number) => defaultComposeP(start, end));

function alist(): [string, e8.Value][] {
  const value = e8.variable("prettify-symbols-alist");
  if (!Array.isArray(value)) return [];
  return value.filter((pair): pair is [string, e8.Value] => Array.isArray(pair) && typeof pair[0] === "string" && pair[0] !== "");
}

/** The symbols of an alist as one regexp, longest first so a longer symbol wins, as regexp-opt does. */
const patterns = new Map<string, RegExp>();
function pattern(symbols: string[]): RegExp {
  const key = symbols.join("\0");
  let re = patterns.get(key);
  if (re === undefined) {
    const sorted = [...symbols].sort((a, b) => b.length - a.length);
    re = new RegExp(sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");
    patterns.set(key, re);
  }
  return re;
}

/** Composes the symbols between start and end, whole lines, as font-lock runs prettify-symbols--compose-symbol. */
function prettify(start: number, end: number): void {
  if (e8.variable("prettify-symbols-mode") !== true) return;
  const pairs = alist();
  const from = e8.lineStart(e8.lineOf(start));
  const to = e8.lineEnd(e8.lineOf(Math.max(start, end - 1)));
  e8.withSilentModifications(() => {
    e8.removeTextProperty(from, to, "composition");
    if (pairs.length === 0) return;
    const replacement = new Map(pairs);
    const predicate = e8.variable("prettify-symbols-compose-predicate");
    const text = e8.bufferSubstringNoProperties(from, to);
    const re = pattern(pairs.map(([s]) => s));
    re.lastIndex = 0;
    // Code units to characters, as the buffer counts.
    let at = 0;
    let chars = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      chars += [...text.slice(at, m.index)].length;
      at = m.index;
      const s = from + chars;
      const e = s + [...m[0]].length;
      const ok = predicate === "prettify-symbols-default-compose-p" ? defaultComposeP(s, e) : e8.funcall(predicate as string, s, e, m[0]);
      if (ok !== null && ok !== false && ok !== undefined) {
        composeRegion(s, e, replacement.get(m[0]) as number | string);
        e8.putTextProperty(s, e, "prettify-symbols-start", s);
        e8.putTextProperty(s, e, "prettify-symbols-end", e);
      }
    }
  });
}

e8.defineMinorMode({
  name: "prettify-symbols-mode",
  lighter: "",
  doc: "Show the symbols prettify-symbols-alist names as other characters, such as lambda as λ, leaving the text itself as it is.",
  onChange: (enabled) => {
    if (enabled) {
      e8.addHook("jit-lock-functions", prettify, { local: true });
      // Composed as it comes into view, as font-lock does for Emacs's.
      e8.call("font-lock-flush");
    } else {
      e8.removeHook("jit-lock-functions", prettify, { local: true });
      e8.withSilentModifications(() => {
        for (const name of ["composition", "prettify-symbols-start", "prettify-symbols-end"]) {
          e8.removeTextProperty(e8.pointMin(), e8.pointMax(), name);
        }
      });
    }
  },
});

defineGlobalizedMinorMode(
  "global-prettify-symbols-mode",
  "prettify-symbols-mode",
  "Turn Prettify Symbols mode on in every buffer whose prettify-symbols-alist names any symbols.",
);
