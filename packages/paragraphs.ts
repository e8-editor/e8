// Moving by paragraphs, after Emacs's paragraphs.el: lines that
// paragraph-start matches start or separate paragraphs, those that
// paragraph-separate matches too separate them, by default blank lines,
// and with a fill prefix a line without it starts one. M-} moves to the
// end of this paragraph or the next, and M-{ to the start; Shift selects
// as they move.

import { transposeSubr } from "simple";
import { forwardLine, regexpQuote, truthy } from "subr";

for (const [name, value, doc] of [
  [
    "paragraph-start",
    "\f\\|[ \t]*$",
    "A regexp for the start of a line that starts or separates paragraphs, matched at the left margin; paragraph-separate says which separate them.",
  ],
  ["paragraph-separate", "[ \t\f]*$", "A regexp for the start of a line that separates paragraphs, matched at the left margin."],
  ["paragraph-ignore-fill-prefix", false, "Whether the paragraph commands leave fill-prefix out of finding paragraphs, as where blank lines alone separate them."],
] as const) {
  e8.defineVariable({ name, value, doc });
}

const bobp = (): boolean => e8.point() <= e8.pointMin();
const bolp = (): boolean => e8.point() === e8.lineBeginningPosition();
/** To the left margin of point's line, as move-to-left-margin with no margin: its start. */
const toLeftMargin = (): void => e8.gotoChar(e8.lineBeginningPosition());
/** A regexp variable without a ^ at its start, as forward-paragraph takes it. */
function unanchored(name: string): string {
  const v = e8.variable(name);
  const s = typeof v === "string" ? v : "";
  return s.startsWith("^") ? s.slice(1) : s;
}

/**
 * Moves over `arg` paragraphs, back if negative, as forward-paragraph: a
 * line paragraph-start matches starts one, or separates them if
 * paragraph-separate matches it too; with a fill prefix, lines without it
 * start one. Returns how many it could not move over.
 */
export function forwardParagraph(argIn: number): number {
  let arg = argIn;
  const fp = e8.variable("fill-prefix");
  const fillPrefixRegexp =
    typeof fp === "string" && fp !== "" && !truthy(e8.variable("paragraph-ignore-fill-prefix")) ? regexpQuote(fp) : undefined;
  const parstart = unanchored("paragraph-start");
  let parsep = unanchored("paragraph-separate");
  if (fillPrefixRegexp !== undefined) parsep = `${parsep}\\|${fillPrefixRegexp}[ \t]*$`;
  const spParstart = `^[ \t]*\\(?:${parstart}\\|${parsep}\\)`;
  const at = (re: string): boolean => e8.lookingAt(re);
  // Kept from one paragraph to the next, as forward-paragraph's found-start is.
  let found = false;
  while (arg < 0 && !bobp()) {
    let start: number;
    if (!at(parsep) && e8.reSearchBackward("^\n", { bound: Math.max(e8.point() - 1, e8.pointMin()), noerror: true }) !== undefined && at(parsep)) {
      arg++;
      continue;
    }
    start = e8.point();
    // Back over lines that separate paragraphs.
    e8.gotoChar(e8.point() - 1);
    e8.gotoChar(e8.lineBeginningPosition());
    while (!bobp() && (toLeftMargin(), at(parsep))) forwardLine(-1);
    if (bobp()) continue;
    arg++;
    // To the end of the line before, then back to a line that starts or separates paragraphs.
    e8.gotoChar(e8.lineEndPosition());
    let real: boolean;
    if (fillPrefixRegexp !== undefined) {
      // A fill prefix overrides paragraph-start.
      while ((e8.gotoChar(e8.lineBeginningPosition()), !bobp()) && (toLeftMargin(), !at(parsep)) && at(fillPrefixRegexp)) forwardLine(-1);
      toLeftMargin();
      real = !bobp();
    } else {
      for (;;) {
        if (e8.reSearchBackward(spParstart, { noerror: true }) === undefined) {
          e8.gotoChar(e8.pointMin());
          break;
        }
        found = true;
        start = e8.point();
        toLeftMargin();
        // A real one: a separator, or a start.
        if (at(parsep) || at(parstart)) break;
        found = false;
        e8.gotoChar(start);
      }
      real = found;
    }
    if (real) {
      // Forward over separators; it cannot reach where it started.
      while (!(e8.point() >= e8.pointMax()) && (toLeftMargin(), at(parsep))) forwardLine(1);
      // Back to the line before the paragraph if it is only margin.
      // As (end-of-line 0): the end of the line before, or the start on the first line.
      const bolHere = e8.lineBeginningPosition();
      e8.gotoChar(bolHere <= e8.pointMin() ? e8.pointMin() : bolHere - 1);
      if (e8.currentColumn() > 0) e8.gotoChar(e8.point() + 1);
      else {
        e8.skipCharsBackward(" \t");
        if (!bolp()) forwardLine(1);
      }
    } else e8.gotoChar(e8.pointMin());
  }
  while (arg > 0 && !(e8.point() >= e8.pointMax())) {
    // Forward over separator lines...
    while (!(e8.point() >= e8.pointMax()) && (toLeftMargin(), !(e8.point() >= e8.pointMax())) && at(parsep)) forwardLine(1);
    if (!(e8.point() >= e8.pointMax())) arg--;
    // ... and one more line.
    forwardLine(1);
    if (fillPrefixRegexp !== undefined) {
      while (!(e8.point() >= e8.pointMax()) && (toLeftMargin(), !(e8.point() >= e8.pointMax())) && !at(parsep) && at(fillPrefixRegexp)) forwardLine(1);
    } else {
      let start = e8.point();
      for (;;) {
        if (e8.reSearchForward(spParstart, { noerror: true }) === undefined) {
          e8.gotoChar(e8.pointMax());
          break;
        }
        start = e8.matchBeginning(0)!;
        e8.gotoChar(start);
        if (e8.point() >= e8.pointMax()) break;
        toLeftMargin();
        if (at(parsep) || at(parstart)) break;
        e8.gotoChar(e8.point() + 1);
      }
      if (e8.point() < e8.pointMax()) e8.gotoChar(start);
    }
  }
  return arg;
}

e8.defineCommand({
  name: "forward-paragraph",
  doc: "Move to the end of this paragraph, or the next if between them. With a prefix argument, that many; back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardParagraph(arg);
  },
});

e8.defineCommand({
  name: "backward-paragraph",
  doc: "Move to the start of this paragraph, or the one before if between them. With a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardParagraph(-arg);
  },
});

e8.bindKey("M-}", "forward-paragraph");
e8.bindKey("M-{", "backward-paragraph");
e8.bindKey("C-<down>", "forward-paragraph");
e8.bindKey("C-<up>", "backward-paragraph");

e8.defineCommand({
  name: "mark-paragraph",
  doc:
    "Put point at the start of this paragraph and the mark at its end; with a prefix argument, at the end of that many.\n\n" +
    "Again, or with the region active, the next paragraphs are marked too.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    if (arg === 0) throw new Error("Cannot mark zero paragraphs");
    const mark = e8.mark();
    if ((e8.lastCommand() === "mark-paragraph" && mark !== undefined) || e8.regionActive()) {
      e8.setMark(e8.saveExcursion(() => {
        e8.gotoChar(mark!);
        forwardParagraph(arg);
        return e8.point();
      }));
      return;
    }
    forwardParagraph(arg);
    e8.pushMark(e8.point(), { activate: true });
    forwardParagraph(-arg);
  },
});
e8.bindKey("M-h", "mark-paragraph");

// Sentences, after paragraphs.el: a sentence ends where sentence-end
// matches, two spaces after a full stop by default, or at the end of its
// paragraph.

for (const [name, doc, value] of [
  ["sentence-end-double-space", "Whether a sentence ends only with two spaces after its full stop, or at the end of a line.", true],
  ["sentence-end-without-period", "Whether a sentence can end with two spaces and no full stop, as in Thai.", false],
  ["sentence-end-without-space", "Characters that end a sentence with no space after them, as Chinese and Japanese full stops do.", "。．？！"],
  ["sentence-end-base", "The regexp for the punctuation that ends a sentence, with what may close it.", "[.?!…‽][]\"'”’)}»›]*"],
  ["sentence-end", "The regexp for the end of a sentence, or nil for the one sentence-end makes from the variables above.", null],
] as const) {
  e8.defineVariable({ name, doc, value });
}

const on = (name: string): boolean => {
  const v = e8.variable(name);
  return v !== null && v !== undefined && v !== false;
};

/** The regexp for the end of a sentence, as sentence-end: sentence-end's value, or one made from the variables. */
export function sentenceEnd(): string {
  const own = e8.variable("sentence-end");
  if (typeof own === "string") return own;
  return (
    (on("sentence-end-without-period") ? "\\w[  ][  ]\\|" : "") +
    "\\(" +
    String(e8.variable("sentence-end-base")) +
    (on("sentence-end-double-space") ? "\\($\\|[  ]$\\|\t\\|[  ][  ]\\)" : "\\($\\|[\t  ]\\)") +
    "\\|[" +
    String(e8.variable("sentence-end-without-space")) +
    "]+" +
    "\\)" +
    "[  \t\n]*"
  );
}

/** Moves to the first character of this paragraph's text, as start-of-paragraph-text. */
function startOfParagraphText(): void {
  const opoint = e8.point();
  forwardParagraph(-1);
  const npoint = e8.point();
  e8.skipCharsForward(" \t\n");
  // Blank lines across where it started: try again from before them.
  if (e8.point() >= opoint && npoint < opoint) {
    e8.gotoChar(npoint);
    if (npoint > e8.pointMin()) startOfParagraphText();
  }
}

/** Moves to the end of this paragraph's text, before its final newline, as end-of-paragraph-text. */
function endOfParagraphText(): void {
  const opoint = e8.point();
  forwardParagraph(1);
  if (e8.point() > 0 && e8.bufferText(e8.point() - 1, e8.point()) === "\n") e8.gotoChar(e8.point() - 1);
  if (e8.point() <= opoint) {
    if (e8.point() < e8.pointMax()) e8.gotoChar(e8.point() + 1);
    if (e8.point() < e8.pointMax()) endOfParagraphText();
  }
}

/** Moves over `arg` sentences, back to their starts if negative, as forward-sentence-default-function. */
export function forwardSentence(argIn = 1): number {
  let arg = argIn;
  const opoint = e8.point();
  const end = sentenceEnd();
  while (arg < 0) {
    const pos = e8.point();
    const [parBeg, parTextBeg] = e8.saveExcursion(() => {
      startOfParagraphText();
      const textBeg = e8.point();
      return [e8.lineBeginningPosition(), textBeg];
    });
    const found =
      e8.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined &&
      (e8.matchEnd(0)! < pos || e8.reSearchBackward(end, { bound: parBeg, noerror: true }) !== undefined);
    e8.gotoChar(found ? e8.matchEnd(0)! : parTextBeg);
    arg++;
  }
  while (arg > 0) {
    const parEnd = e8.saveExcursion(() => {
      endOfParagraphText();
      return e8.point();
    });
    if (e8.reSearchForward(end, { bound: parEnd, noerror: true }) !== undefined) e8.skipCharsBackward(" \t\n");
    else e8.gotoChar(parEnd);
    arg--;
  }
  const to = e8.constrainToField(e8.point(), opoint, true);
  e8.gotoChar(to);
  return to;
}

/** How many sentences there are from start to end, as count-sentences. */
export function countSentences(start: number, end: number): number {
  return e8.letBind({ "inhibit-field-text-motion": true }, () =>
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.narrowToRegion(start, end);
        e8.gotoChar(e8.pointMin());
        let sentences = 0;
        let prev = e8.point();
        let next: number | undefined = forwardSentence();
        while (next !== undefined && prev !== next) {
          prev = next;
          try {
            next = forwardSentence();
          } catch {
            next = undefined;
          }
          sentences++;
        }
        // Not a last sentence that is only space.
        if (e8.skipCharsBackward(" \t\n") !== 0) sentences--;
        return sentences;
      }),
    ),
  );
}

e8.defineCommand({
  name: "forward-sentence",
  doc: "Move to the end of this sentence, or the next if between them; with a prefix argument, that many, back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(arg);
  },
});

e8.defineCommand({
  name: "backward-sentence",
  doc: "Move to the start of this sentence, or the one before if at its start; with a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    forwardSentence(-arg);
  },
});

e8.defineCommand({
  name: "kill-sentence",
  doc: "Kill from point to the end of the sentence; with a prefix argument, to the end of that many, back if negative.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    e8.killRegion(p, forwardSentence(arg));
  },
});

e8.defineCommand({
  name: "backward-kill-sentence",
  doc: "Kill from point back to the start of the sentence; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    e8.killRegion(p, forwardSentence(-arg));
  },
});

e8.defineCommand({
  name: "mark-end-of-sentence",
  doc: "Put the mark at the end of the sentence; again, at the end of the next.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const mark = e8.mark();
    const again = e8.lastCommand() === "mark-end-of-sentence" && mark !== undefined;
    const to = e8.saveExcursion(() => {
      if (again) e8.gotoChar(mark!);
      return forwardSentence(arg);
    });
    e8.pushMark(to, { activate: true });
  },
});

e8.bindKey("M-e", "forward-sentence");
e8.bindKey("M-a", "backward-sentence");
e8.bindKey("M-k", "kill-sentence");
e8.bindKey("C-x DEL", "backward-kill-sentence");
e8.defun("count-sentences", (start: number, end: number) => countSentences(start, end));

e8.defineCommand({
  name: "kill-paragraph",
  doc: "Kill from point to the end of the paragraph; with a prefix argument, to the end of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    forwardParagraph(arg);
    e8.killRegion(p, e8.point());
  },
});

e8.defineCommand({
  name: "backward-kill-paragraph",
  doc: "Kill from point back to the start of the paragraph; with a prefix argument, back to the start of that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    forwardParagraph(-arg);
    e8.killRegion(p, e8.point());
  },
});

e8.defineCommand({
  name: "transpose-paragraphs",
  doc: "Exchange this paragraph with the one before; with a prefix argument, move it past that many.",
  run: () => transposeSubr((n) => forwardParagraph(n), e8.prefixNumericValue()),
});

e8.defineCommand({
  name: "transpose-sentences",
  doc: "Exchange this sentence with the one before; with a prefix argument, move it past that many.",
  run: () =>
    transposeSubr((n) => {
      forwardSentence(n);
    }, e8.prefixNumericValue()),
});
