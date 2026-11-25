// Rectangles, after Emacs's rect.el: the text between two columns on the
// lines from point to the mark, killed (C-x r k), deleted (C-x r d),
// copied (C-x r M-w), yanked (C-x r y), opened (C-x r o), cleared (C-x r c),
// replaced by a string (C-x r t) or numbered (C-x r N).

import { barfIfBufferReadOnly } from "subr";

/**
 * Moves to a column, as move-to-column: with `force` true, spaces pad a
 * line too short and a tab across the column becomes spaces; with
 * "coerce", only the tab does. Returns the column reached.
 */
export function moveToColumn(column: number, force: boolean | "coerce" = false): number {
  const reached = e8.moveToColumn(column);
  if (reached > column && force !== false && e8.point() > e8.pointMin() && e8.charAfter(e8.point() - 1) === "\t") {
    const tab = e8.point() - 1;
    e8.gotoChar(tab);
    const from = e8.currentColumn();
    e8.deleteRegion(tab, tab + 1);
    e8.insert(" ".repeat(reached - from));
    return e8.moveToColumn(column);
  }
  if (reached < column && force === true) {
    e8.indentTo(column);
    return e8.currentColumn();
  }
  return reached;
}

/** The columns of a rectangle's corners, left first. */
function columns(start: number, end: number): [number, number] {
  const col = (pos: number) =>
    e8.saveExcursion(() => {
      e8.gotoChar(pos);
      return e8.currentColumn();
    });
  const [a, b] = [col(start), col(end)];
  return a <= b ? [a, b] : [b, a];
}

/**
 * Calls `f` with the rectangle's columns at the start of each of its
 * lines, as apply-on-rectangle, and returns where point was after the last.
 */
export function applyOnRectangle(f: (startcol: number, endcol: number) => void, startIn: number, endIn: number): number {
  const [start, end] = [Math.min(startIn, endIn), Math.max(startIn, endIn)];
  return e8.saveExcursion(() => {
    const [startcol, endcol] = columns(startIn, endIn);
    const endpt = e8.makeMarker(e8.lineEndPosition(end));
    e8.gotoChar(e8.lineBeginningPosition(start));
    let final = e8.point();
    for (;;) {
      f(startcol, endcol);
      final = e8.point();
      const next = e8.lineEndPosition() + 1;
      if (next > e8.pointMax() || next > e8.markerPosition(endpt)!) break;
      e8.gotoChar(next);
    }
    e8.deleteMarker(endpt);
    return final;
  });
}

/** The rectangle's text, a string for each line, deleted with `del`, as delete-extract-rectangle and extract-rectangle. */
function extract(start: number, end: number, del: boolean, fill = false): string[] {
  const lines: string[] = [];
  applyOnRectangle((startcol, endcol) => {
    if (del) {
      if (moveToColumn(startcol, fill ? true : "coerce") < startcol) {
        lines.push(" ".repeat(endcol - startcol));
        return;
      }
      const pt = e8.point();
      moveToColumn(endcol, true);
      lines.push(e8.bufferSubstringNoProperties(pt, e8.point()));
      e8.deleteRegion(pt, e8.point());
    } else {
      // As extract-rectangle-line: tabs across the edges come out as spaces.
      e8.moveToColumn(startcol);
      const s = e8.point();
      let begextra = e8.currentColumn() - startcol;
      e8.moveToColumn(endcol);
      let endextra = endcol - e8.currentColumn();
      let line = "";
      e8.saveExcursion(() => {
        const e = e8.point();
        e8.gotoChar(s);
        while (e8.point() < e) {
          const c = e8.charAfter(e8.point())!;
          const before = e8.currentColumn();
          e8.gotoChar(e8.point() + 1);
          line += c === "\t" ? " ".repeat(e8.currentColumn() - before) : c;
        }
      });
      if (begextra < 0) {
        endextra += begextra;
        begextra = 0;
      }
      if (endextra < 0) endextra = 0;
      lines.push(" ".repeat(begextra) + line + " ".repeat(endextra));
    }
  }, start, end);
  return lines;
}

/** Inserts a rectangle's lines at point and the lines after, at point's column, as insert-rectangle: the mark at its top left, point at its bottom right. */
export function insertRectangle(lines: string[]): void {
  const column = e8.currentColumn();
  e8.pushMark(e8.point());
  // As push-mark says, unless a macro runs or the minibuffer is open.
  if (!e8.executingKbdMacro() && e8.minibufferDepth() === 0) e8.message("Mark set");
  lines.forEach((line, i) => {
    if (i > 0) {
      const next = e8.lineEndPosition() + 1;
      if (next > e8.pointMax()) {
        e8.gotoChar(e8.pointMax());
        e8.insert("\n");
      } else {
        e8.gotoChar(next);
      }
      moveToColumn(column, true);
    }
    e8.insertForYank(line);
  });
}

/** The rectangle killed last, as killed-rectangle. */
let killedRectangle: string[] | undefined;

export const lastKilledRectangle = (): string[] | undefined => killedRectangle;

const region = [
  { name: "start", kind: "region-beginning" },
  { name: "end", kind: "region-end" },
] as const;

const readOnly = () => {
  barfIfBufferReadOnly();
};

e8.defineCommand({
  name: "delete-rectangle",
  barfIfReadOnly: true,
  doc: "Delete the text in the rectangle between point and the mark; with a prefix argument, lines too short are padded first.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: e8.PrefixArg) => {
    readOnly();
    // Point stays where it was, as apply-on-rectangle's save-excursion leaves it.
    applyOnRectangle((startcol, endcol) => {
      if (moveToColumn(startcol, fill !== null ? true : "coerce") >= startcol) {
        const from = e8.point();
        moveToColumn(endcol, "coerce");
        e8.deleteRegion(from, e8.point());
      }
    }, start, end);
  },
});

e8.defineCommand({
  name: "kill-rectangle",
  doc: "Kill the text in the rectangle between point and the mark, to be yanked with C-x r y; with a prefix argument, short lines are padded.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: e8.PrefixArg) => {
    // As kill-rectangle's handler for a deletion refused: copied, then refused.
    if (e8.bufferReadOnly() && !e8.variable("inhibit-read-only")) {
      killedRectangle = extract(start, end, false);
      e8.signal("buffer-read-only", `Buffer is read-only: #<buffer ${e8.bufferName()}>`);
    }
    killedRectangle = extract(start, end, true, fill !== null);
  },
});

e8.defineCommand({
  name: "copy-rectangle-as-kill",
  doc: "Copy the text in the rectangle between point and the mark, to be yanked with C-x r y.",
  params: [...region],
  run: (start: number, end: number) => {
    killedRectangle = extract(start, end, false);
    e8.deactivateMark();
  },
});

e8.defineCommand({
  name: "yank-rectangle",
  barfIfReadOnly: true,
  doc: "Insert the rectangle killed last, its top left corner at point.",
  run: () => {
    readOnly();
    if (killedRectangle === undefined) e8.userError("No rectangle to yank");
    insertRectangle(killedRectangle!);
  },
});

e8.defineCommand({
  name: "open-rectangle",
  barfIfReadOnly: true,
  doc: "Insert blank space filling the rectangle between point and the mark, pushing its text right; with a prefix argument, short lines too.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: e8.PrefixArg) => {
    readOnly();
    applyOnRectangle((startcol, endcol) => {
      if (moveToColumn(startcol, fill !== null ? true : "coerce") === startcol && !(fill === null && e8.point() === e8.lineEndPosition())) {
        e8.indentTo(endcol);
      }
    }, start, end);
    e8.gotoChar(start);
  },
});

e8.defineCommand({
  name: "clear-rectangle",
  barfIfReadOnly: true,
  doc: "Replace the text in the rectangle between point and the mark with spaces; with a prefix argument, short lines are padded too.",
  params: [...region, { name: "fill", kind: "prefix" }],
  run: (start: number, end: number, fill: e8.PrefixArg) => {
    readOnly();
    applyOnRectangle((startcol, endcolIn) => {
      let endcol = endcolIn;
      const pt = e8.lineEndPosition();
      if (moveToColumn(startcol, fill !== null ? true : "coerce") !== startcol) return;
      const eolCol = e8.saveExcursion(() => {
        e8.gotoChar(pt);
        return e8.currentColumn();
      });
      if (fill === null && eolCol <= endcol) {
        e8.deleteRegion(e8.point(), pt);
      } else {
        const from = e8.point();
        moveToColumn(endcol, true);
        endcol = e8.currentColumn();
        e8.deleteRegion(from, e8.point());
        e8.indentTo(endcol);
      }
    }, start, end);
  },
});

e8.defineVariable({ name: "string-rectangle-history", doc: "Strings given to C-x r t, newest first.", value: [] });

e8.defineCommand({
  name: "string-rectangle",
  barfIfReadOnly: true,
  doc: "Replace the text in the rectangle between point and the mark with a string on each line.",
  params: [...region],
  run: async (start: number, end: number) => {
    readOnly();
    const history = e8.variable("string-rectangle-history");
    const def = Array.isArray(history) && typeof history[0] === "string" ? history[0] : undefined;
    const answer = await e8.readString(def === undefined ? "String rectangle: " : `String rectangle (default ${def}): `, {
      history: "string-rectangle-history",
      default: def,
    });
    const string = answer === "" && def !== undefined ? def : answer;
    const final = applyOnRectangle((startcol, endcol) => {
      moveToColumn(startcol, true);
      if (moveToColumn(startcol, "coerce") >= startcol) {
        const from = e8.point();
        moveToColumn(endcol, "coerce");
        e8.deleteRegion(from, e8.point());
      }
      e8.insert(string);
    }, start, end);
    e8.gotoChar(final);
  },
});

e8.defineCommand({
  name: "rectangle-number-lines",
  doc:
    "Insert numbers down the left edge of the rectangle between point and the mark, from 1.\n\n" +
    "With a prefix argument, ask for the first number and the format, %d by default, padded to the widest.",
  params: [...region, { name: "arg", kind: "prefix" }],
  run: async (start: number, end: number, arg: e8.PrefixArg) => {
    readOnly();
    const [beg, fin] = [Math.min(start, end), Math.max(start, end)];
    // count-lines: the newlines between, and a line the region ends inside.
    const lines = e8.lineOf(fin) - e8.lineOf(beg) + (fin > beg && fin !== e8.lineStart(e8.lineOf(fin)) ? 1 : 0);
    // As rectangle--default-line-number-format: as wide as the count plus the start.
    const defaultFormat = (at: number): string => `%${String(lines + at).length}d `;
    let first = 1;
    let format = defaultFormat(first);
    if (arg !== null) {
      // As read-number: empty for the default, and asked again until a number.
      for (;;) {
        const answer = (await e8.readString("Number to count from (default 1): ")).trim();
        if (answer === "") break;
        if (/^[-+]?\d+$/.test(answer)) {
          first = Number(answer);
          break;
        }
        e8.message("Please enter a number.");
      }
      format = await e8.readString("Format string: ", { initial: defaultFormat(first) });
    }
    let n = first;
    // Point stays where it was, as apply-on-rectangle leaves it.
    applyOnRectangle((startcol) => {
      moveToColumn(startcol, true);
      e8.insert(e8.format(format, n));
      n++;
    }, start, end);
  },
});

for (const [keys, command] of [
  ["C-x r k", "kill-rectangle"],
  ["C-x r d", "delete-rectangle"],
  ["C-x r y", "yank-rectangle"],
  ["C-x r o", "open-rectangle"],
  ["C-x r c", "clear-rectangle"],
  ["C-x r t", "string-rectangle"],
  ["C-x r N", "rectangle-number-lines"],
  ["C-x r M-w", "copy-rectangle-as-kill"],
] as const) {
  e8.bindKey(keys, command);
}
