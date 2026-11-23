// Org tables, after Emacs's org-table.el: lines starting with "|", fields
// between bars, and rules ("|---+---|") between rows. The commands follow
// org-table.el's own: moving between fields with TAB, S-TAB and RET aligns
// the table first if it changed since it was last aligned, making every
// column as wide as its widest field, with numbers to the right when most
// of a column's fields are numbers. org-mode's TAB, S-TAB, RET and the
// M-arrow and S-arrow keys call these commands when point is in a table.

import {
  charAt,
  dropMarker,
  edDelete,
  edInsert,
  lineAt,
  lineStartOrEnd,
  marker,
  type Marker,
  markers,
  orgRegionActive,
  placeMarkers,
} from "org-macs";
import { allMatches, charCount, forwardLine } from "subr";

e8.defineVariable({
  name: "org-table-auto-blank-field",
  doc: "Whether typing right after TAB, S-TAB, RET or C-c C-c moved into a field replaces what the field holds.",
  value: true,
});

e8.defineVariable({
  name: "org-table-number-fraction",
  doc: "A column whose fields are at least this fraction numbers is aligned to the right.",
  value: 0.5,
});

e8.defineVariable({
  name: "org-table-automatic-realign",
  doc: "Whether moving between fields aligns the table when it has changed since it was last aligned.",
  value: true,
});

e8.defineVariable({
  name: "org-table-tab-jumps-over-hlines",
  doc: "Whether TAB at the end of a row goes past a rule below it to the next row, rather than adding a row.",
  value: true,
});

e8.defineVariable({
  name: "org-table--aligned",
  doc:
    "When the table was last aligned: the buffer's modified tick then, and where the table began and ended. " +
    "A table that changed since needs aligning again, as Org's org-table-may-need-update says.",
  value: null,
  local: true,
});

const TABLE_LINE = /^[ \t]*\|/;
const HLINE = /^[ \t]*\|-/;
const DATALINE = /^[ \t]*\|(?!-)/;
const NUMBER =
  /^(?:[<>]?[-+^.0-9]*[0-9][-+^.0-9eEdDx()%:]*|[<>]?[-+]?0[xX][0-9a-fA-F.]+|[<>]?[-+]?[0-9]+#[0-9a-zA-Z.]+|nan|[-+u]?inf)$/;

export function restOfLine(pos = e8.point()): string {
  return e8.bufferText(pos, e8.lineEnd(lineAt(pos)));
}

export function beforeOnLine(pos = e8.point()): string {
  return e8.bufferText(e8.lineStart(lineAt(pos)), pos);
}

function atBol(): boolean {
  return e8.point() === e8.lineStart(lineAt());
}

/** Runs body and puts point back where it was, moved as a marker, as save-excursion does. */
const saveExcursion = <T>(body: () => T): T => e8.saveExcursion(body);

function isTableLine(line: number): boolean {
  if (line < 0 || line >= e8.lineCount()) return false;
  // Only lines in the accessible portion, as org-table-begin searches.
  if (e8.lineEnd(line) < e8.pointMin() || e8.lineStart(line) > e8.pointMax()) return false;
  return TABLE_LINE.test(e8.lineText(line));
}

export function atTable(pos = e8.point()): boolean {
  return isTableLine(lineAt(pos));
}

function atHline(pos = e8.point()): boolean {
  return HLINE.test(e8.lineText(lineAt(pos)));
}

function tableHere(): void {
  if (!atTable()) e8.userError("Not at a table");
}

function firstLine(line = lineAt()): number {
  let first = line;
  while (isTableLine(first - 1)) first--;
  return first;
}

function lastLine(line = lineAt()): number {
  let last = line;
  while (isTableLine(last + 1)) last++;
  return last;
}

/** Where the table at point begins: the start of its first line, as org-table-begin finds it. */
function tableBegin(): number {
  return e8.lineStart(firstLine());
}

/** Where the table at point ends: the start of the line after it, or the end of the buffer. */
function tableEnd(): number {
  return lineStartOrEnd(lastLine() + 1);
}

/** Which field point is in, counting the bars before it, as org-table-current-column does. */
function currentColumn(pos = e8.point()): number {
  const before = beforeOnLine(pos);
  if (!before.includes("|")) return 0;
  return (before.match(atHline(pos) ? /[+|]/g : /\|/g) ?? []).length;
}

/**
 * Moves to field n of point's line, after its bar and one space, as
 * org-table-goto-column does. With onDelim, to the bar itself; with force,
 * adding fields that are missing.
 */
function gotoColumn(n: number, onDelim = false, force = false): void {
  let p = e8.lineStart(lineAt());
  if (n > 0) {
    while (--n > -1) {
      const rest = restOfLine(p);
      const i = rest.indexOf("|");
      if (i >= 0) p += charCount(rest.slice(0, i)) + 1;
      else if (force) {
        const text = e8.lineText(lineAt(p));
        const bar = e8.lineStart(lineAt(p)) + charCount(text.slice(0, text.lastIndexOf("|") + 1));
        edInsert(bar, " | ");
        p = bar + 3;
      } else break;
    }
    if (force && !restOfLine(p).includes("|")) {
      const m = marker(p);
      edInsert(e8.lineEnd(lineAt(p)), " | ");
      p = m.pos;
      dropMarker(m);
    }
    if (onDelim) p -= 1;
    else if (charAt(p) === " ") p += 1;
  }
  e8.gotoChar(p);
}

type Row = "hline" | string[];

/** The table at point as rows of fields, as org-table-to-lisp reads it. */
function tableToLisp(line = lineAt()): Row[] {
  const rows: Row[] = [];
  for (let l = firstLine(line); l <= lastLine(line); l++) {
    const text = e8.lineText(l);
    let i = (/^[ \t]*/.exec(text)?.[0].length ?? 0) + 1;
    if (text[i] === "-") {
      rows.push("hline");
      continue;
    }
    const fields: string[] = [];
    for (;;) {
      while (text[i] === " " || text[i] === "\t") i++;
      if (i >= text.length) break;
      const q = i;
      while (i < text.length && text[i] !== "|") i++;
      let e = i;
      while (e > q && (text[e - 1] === " " || text[e - 1] === "\t")) e--;
      fields.push(text.slice(q, e));
      if (i < text.length) i++;
    }
    rows.push(fields);
  }
  return rows;
}

export function needsAlign(): boolean {
  const state = e8.variable("org-table--aligned");
  return !Array.isArray(state) || state[0] !== e8.bufferCharsModifiedTick();
}

/** Records that the table at point is aligned, as setting org-table-may-need-update to nil does. */
export function markAligned(line = lineAt()): void {
  e8.setVariable("org-table--aligned", [e8.bufferCharsModifiedTick(), e8.lineStart(firstLine(line)), lineStartOrEnd(lastLine(line) + 1)]);
}

/** Pads a field to a width, as org-table--align-field does. */
/**
 * How wide a field shows, as org-string-width measures it: a bracket link
 * as its description, or its link without one, while org-link-descriptive
 * hides the rest.
 */
function shownWidth(field: string): number {
  const descriptive = e8.variable("org-link-descriptive");
  const shown = descriptive === false || descriptive === null
    ? field
    : field.replace(/\[\[((?:[^\]\\]|\\.)+)\](?:\[([^\]]+)\])?\]/g, (_m, link: string, desc?: string) => desc ?? link);
  return e8.stringWidth(shown);
}

function alignField(field: string, width: number, align: string): string {
  const spaces = width - shownWidth(field);
  const prefix = align === "r" ? " ".repeat(spaces) : align === "c" ? " ".repeat(Math.floor(spaces / 2)) : "";
  return ` ${prefix}${field}${" ".repeat(spaces - prefix.length)} `;
}

/**
 * Aligns the table at point, rewriting only the rows that change, and
 * puts point at the start of the field it was in, as org-table-align does.
 */
function align(): void {
  const lineMark = marker(e8.lineStart(lineAt()));
  const column = currentColumn();
  // On the line just after a table, as org-table-begin and org-table-end find it, the table is the one above.
  const at = !isTableLine(lineAt()) && isTableLine(lineAt() - 1) ? lineAt() - 1 : lineAt();
  try {
    const first = firstLine(at);
    const table = tableToLisp(at);
    const rows = table.filter((r): r is string[] => r !== "hline");
    let widths: number[];
    let aligns: string[];
    if (rows.length === 0) {
      const n = 1 + (e8.lineText(first).match(/\+/g) ?? []).length;
      widths = Array(n).fill(1);
      aligns = Array(n).fill("l");
    } else {
      const n = Math.max(...rows.map((r) => r.length));
      widths = [];
      aligns = [];
      const fraction = Number(e8.variable("org-table-number-fraction") ?? 0.5);
      for (let i = 0; i < n; i++) {
        let width = 1;
        let fixed: string | undefined;
        let numbers = 0;
        let nonEmpty = 0;
        for (const row of rows) {
          const cell = row[i] ?? "";
          width = Math.max(width, shownWidth(cell));
          if (fixed !== undefined || cell === "") continue;
          const cookie = /^<([lrc])[0-9]*>$/.exec(cell);
          if (cookie) fixed = cookie[1];
          else {
            nonEmpty++;
            if (NUMBER.test(cell)) numbers++;
          }
        }
        widths.push(width);
        aligns.push(fixed ?? (numbers >= fraction * nonEmpty ? "r" : "l"));
      }
    }
    const rule = table.includes("hline") ? widths.map((w) => "-".repeat(w + 2)).join("+") : "";
    const indent = /^[ \t]*\|/.exec(e8.lineText(first))?.[0] ?? "|";
    let line = first;
    for (const row of table) {
      const previous = e8.lineText(line);
      const fields = row === "hline" ? [] : [...row, ...Array(Math.max(0, widths.length - row.length)).fill("")];
      const updated =
        indent + (row === "hline" ? rule : fields.map((f, i) => alignField(f, widths[i], aligns[i])).join("|")) + "|";
      if (updated !== previous) {
        const bol = e8.lineStart(line);
        edInsert(bol, `${updated}\n`);
        // The next line's start, or the narrowing's end, as line-beginning-position stops there.
        edDelete(bol + charCount(updated) + 1, Math.min(lineStartOrEnd(line + 2), e8.pointMax()));
      }
      line++;
    }
  } finally {
    e8.gotoChar(lineMark.pos);
    dropMarker(lineMark);
    gotoColumn(column);
  }
  markAligned(isTableLine(lineAt()) ? lineAt() : Math.max(0, lineAt() - 1));
}

/** What org-table-justify-field-maybe does without a new value: notices when point left the table last aligned. */
function justifyFieldMaybe(): void {
  if (needsAlign() || atHline()) return;
  const state = e8.variable("org-table--aligned");
  if (Array.isArray(state) && (e8.point() < Number(state[1]) || e8.point() >= Number(state[2]))) {
    e8.setVariable("org-table--aligned", null);
  }
}

function alignIfNeeded(): void {
  if (e8.variable("org-table-automatic-realign") === true && needsAlign()) align();
}

/** Errors unless point is in a field of a table row, as org-table-check-inside-data-field does. */
function checkInsideDataField(assumeTable = false): void {
  if ((assumeTable || atTable()) && /[^ \t]/.test(beforeOnLine()) && !atHline() && !/^[ \t]*$/.test(restOfLine())) return;
  e8.userError("Not in table data field");
}

/** The table line as bars and spaces, as org-table-clean-line makes it. */
function cleanLine(s: string): string {
  if (HLINE.test(s)) return Array.from(s, (c) => (c === "|" || c === "+" ? "|" : " ")).join("");
  for (;;) {
    const m = /\|([ \t]*?[^ \t\r\n|][^\r\n|]*)\|/.exec(s);
    if (!m) return s;
    s = s.slice(0, m.index) + "|" + " ".repeat(e8.stringWidth(m[1])) + "|" + s.slice(m.index + m[0].length);
  }
}

/** Moves to the line's column, or its end, as move-to-column does. */
function moveToColumn(col: number): void {
  const line = lineAt();
  e8.gotoChar(e8.lineStart(line) + Math.min(col, e8.lineEnd(line) - e8.lineStart(line)));
}

function currentColumnOfPoint(): number {
  return e8.point() - e8.lineStart(lineAt());
}

/** Moves down onto a data row for the column commands, as org-table-find-dataline does. */
function findDataline(): void {
  if (!atHline()) return;
  const col = currentColumnOfPoint();
  const end = tableEnd();
  let line = lineAt() + 1;
  while (lineStartOrEnd(line) < end && HLINE.test(e8.lineText(line))) line++;
  if (lineStartOrEnd(line) >= end) {
    // Org has moved down a line at a time by then.
    e8.gotoChar(lineStartOrEnd(line));
    e8.userError("Cannot find data row for column operation");
  }
  e8.gotoChar(e8.lineStart(line));
  moveToColumn(col);
}

function insertRow(below: boolean): void {
  tableHere();
  if (e8.point() === e8.pointMax()) saveExcursion(() => edInsert(e8.point(), "\n"));
  if (!/\|[ \t]*$/.test(e8.lineText(lineAt()))) align();
  const line = e8.lineText(lineAt());
  let fresh = cleanLine(line);
  const special = /^[ \t]*\| *[#*$] *\|/.exec(line);
  if (special) fresh = fresh.replace(/^[ \t]*\| *[#*$] *\|/, special[0]);
  forwardLine(below ? 1 : 0);
  if (!atBol()) edInsert(e8.point(), "\n");
  const before = needsAlign();
  const at = e8.point();
  edInsert(at, `${fresh}\n`, true);
  e8.gotoChar(at);
  const m = /\| ?/.exec(restOfLine());
  if (m) e8.gotoChar(at + charCount(restOfLine().slice(0, (m.index ?? 0) + m[0].length)));
  if (before) align();
  else markAligned();
}

e8.defineCommand({
  name: "org-table-align",
  doc: "Align the table at point: every column as wide as its widest field, numbers to the right.",
  run: () => {
    tableHere();
    align();
  },
});

e8.defineCommand({
  name: "org-table-next-field",
  doc: "Move to the next field, going on to the next row, and adding one at the end. The table is aligned first if it changed.",
  run: () => {
    maybeEvalFormula();
    alignIfNeeded();
    const end = tableEnd();
    if (atHline()) e8.gotoChar(e8.lineEnd(lineAt()));
    const searchBar = (): void => {
      const text = e8.bufferText(e8.point(), end);
      const i = text.indexOf("|");
      if (i < 0) throw new Error("Search failed");
      e8.gotoChar(e8.point() + charCount(text.slice(0, i)) + 1);
    };
    try {
      searchBar();
      if (/^[ \t]*$/.test(restOfLine())) searchBar();
      if (charAt(e8.point()) === "-" && e8.variable("org-table-tab-jumps-over-hlines") === true) {
        for (let l = lineAt() + 1; lineStartOrEnd(l) < end; l++) {
          const m = /^[ \t]*\|([^-])/.exec(e8.lineText(l));
          if (m) {
            e8.gotoChar(e8.lineStart(l) + m[0].length - 1);
            break;
          }
        }
      }
      if (charAt(e8.point()) === "-") {
        forwardLine(-1);
        insertRow(true);
      } else if (charAt(e8.point()) === " ") e8.gotoChar(e8.point() + 1);
    } catch {
      insertRow(true);
    }
  },
});

e8.defineCommand({
  name: "org-table-previous-field",
  doc: "Move to the previous field, going back to the row before. The table is aligned first if it changed.",
  run: () => {
    justifyFieldMaybe();
    alignIfNeeded();
    if (atHline()) e8.gotoChar(e8.lineEnd(lineAt()));
    const start = tableBegin();
    const origin = e8.point();
    const barBefore = (from: number): number => {
      const text = e8.bufferText(start, from);
      const i = text.lastIndexOf("|");
      if (i < 0) throw new Error("Search failed");
      return start + charCount(text.slice(0, i));
    };
    try {
      let p = barBefore(barBefore(e8.point()));
      while (/^\|(?:-|[ \t]*$)/.test(restOfLine(p))) p = barBefore(p);
      e8.gotoChar(p);
    } catch {
      e8.gotoChar(origin);
      e8.userError("Cannot move to previous table field");
    }
    const m = /^\| ?/.exec(restOfLine());
    if (m) e8.gotoChar(e8.point() + m[0].length);
  },
});

e8.defineCommand({
  name: "org-table-next-row",
  doc: "Move to the same field in the next row, adding a row before a rule or at the end. The table is aligned first if it changed.",
  run: () => nextRow(true),
});

/** Moves to the same field of the next row, adding one before a rule or at the end, as org-table-next-row does; aligning first if ALIGN and the table changed. */
function nextRow(alignFirst: boolean): void {
  maybeEvalFormula();
  if (alignFirst) alignIfNeeded();
  const col = currentColumn();
  forwardLine(1);
  if (!atBol()) edInsert(e8.point(), "\n");
  if (!atTable() || atHline()) {
    forwardLine(-1);
    insertRow(true);
  }
  gotoColumn(col);
  const before = beforeOnLine();
  e8.gotoChar(e8.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|") + 1)));
  if (charAt(e8.point()) === " ") e8.gotoChar(e8.point() + 1);
}

/** Blanks the field at point, keeping its width, and moves to its start, as org-table-blank-field does. */
export function blankField(): void {
  checkInsideDataField();
  const before = beforeOnLine();
  const bar = e8.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|")));
  // Point goes back to the bar first, so it stays there when the field is empty.
  e8.gotoChar(bar);
  const m = /^\|[^|\n]+/.exec(restOfLine(bar));
  if (m) {
    const len = e8.stringWidth(m[0]);
    edDelete(bar, bar + charCount(m[0]));
    edInsert(bar, "|" + " ".repeat(len - 1));
    e8.gotoChar(bar + 2);
  }
}

e8.defineCommand({
  name: "org-table-blank-field",
  doc: "Blank the field at point, keeping its width.",
  run: () => blankField(),
});

/** The text of field n of point's row, replacing it with `replace` if given, as org-table-get-field does. */
function getField(n?: number, replace?: string): string {
  if (n !== undefined) gotoColumn(n);
  const before = beforeOnLine();
  const start = e8.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|") + 1));
  e8.gotoChar(start);
  if (start === e8.lineStart(lineAt()) || /^[ \t]*$/.test(restOfLine())) return "";
  const val = /^[^|\r\n]*/.exec(restOfLine())?.[0] ?? "";
  if (replace !== undefined) {
    edDelete(start, start + charCount(val));
    edInsert(start, replace === "" ? " " : replace);
  }
  e8.gotoChar(Math.min(e8.lineEnd(lineAt()), start + 1));
  return val;
}

e8.defineVariable({
  name: "org-table-copy-increment",
  doc:
    "Whether org-table-copy-down increments a number, a number before or after text, or a timestamp's day as it copies it: " +
    "t by the difference from the field above, a number by that much, nil not at all.",
  value: true,
});

/** A number as string-to-number reads it: an integer exactly, as a bignum, or a float. */
type LispNumber = { int: bigint; float?: undefined } | { float: number; int?: undefined };

function lispNumber(text: string): LispNumber {
  // A float has digits after its point, or an exponent with digits.
  if (/\.\d|[eE][+-]?\d/.test(text)) return { float: Number(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text)![0]) };
  return { int: BigInt(/^[+-]?\d+/.exec(text)![0]) };
}

/** Writes a float as %g does with PREC significant digits. */
function formatG(x: number, prec: number): string {
  const [mantissa, exp] = x.toExponential(prec - 1).split("e");
  const e = Number(exp);
  const strip = (t: string) => (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t);
  if (e < -4 || e >= prec) return `${strip(mantissa)}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  return strip(x.toFixed(Math.max(0, prec - 1 - e)));
}

/**
 * A number as number-to-string writes it: an integer as it is, a float in
 * the fewest digits from 15 that read back the same, as dtoastr finds them,
 * with a point, as 3.0, or in exponent form, as 1e+20.
 */
function numberString(n: LispNumber): string {
  if (n.int !== undefined) return String(n.int);
  const x = n.float;
  if (Number.isNaN(x)) return "0.0e+NaN";
  if (!Number.isFinite(x)) return x > 0 ? "1.0e+INF" : "-1.0e+INF";
  let text = Object.is(x, -0) ? "-0" : formatG(x, 15);
  for (let prec = 16; prec <= 17 && Number(text) !== x; prec++) text = formatG(x, prec);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

/** Whether a string has more than whitespace, as org-string-nw-p, which counts only spaces, tabs and line ends. */
function nonWhite(s: string | undefined): s is string {
  return s !== undefined && /[^ \t\r\n]/.test(s);
}

/** A string without the spaces, tabs and line ends around it, as org-trim. */
function orgTrim(s: string): string {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

/** Runs `f` in a buffer of its own, killed afterwards, as with-temp-buffer. */
function withTempBuffer<T>(f: () => T): T {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, f);
  } finally {
    e8.call("kill-buffer", name);
  }
}

/**
 * The field after FIELD, as org-table--increment-field makes it: a number,
 * a number before or after text, or a timestamp, moved on by its
 * difference from PREVIOUS when that is of the same kind, else by
 * org-table-copy-increment's number or 1; anything else as it is.
 */
function incrementField(field: string, previous: string | undefined): string {
  const option = e8.variable("org-table-copy-increment");
  const step: LispNumber = typeof option === "number" ? (Number.isInteger(option) ? { int: BigInt(option) } : { float: option }) : { int: 1n };
  type Kind = { type: "number" | "prefix" | "suffix" | "timestamp"; n: LispNumber; text: string; rest: string };
  const analyze = (f: string | undefined): Kind | undefined => {
    if (!nonWhite(f)) return undefined;
    let m: RegExpExecArray | null;
    // Lisp's syntax for numbers: an exponent's digits may be left out.
    if (/^[+-]?(?:\d+\.?|\d*\.\d+)(?:[eE](?:[+-]?\d+)?)?$/.test(f)) return { type: "number", n: lispNumber(f), text: f, rest: "" };
    if ((m = /^\d+/.exec(f))) return { type: "prefix", n: lispNumber(m[0]), text: f, rest: f.slice(m[0].length) };
    if ((m = /\d+$/.exec(f))) return { type: "suffix", n: lispNumber(m[0]), text: f, rest: f.slice(0, m.index) };
    // org-ts-regexp3, anywhere in the field.
    if (/[[<]\d{4}-\d{2}-\d{2}(?: *[^\]+0-9>\r\n -]+)?(?: +\d{1,2}:\d{2})?[^\]>\r\n]{0,16}[\]>]/.test(f)) {
      return { type: "timestamp", n: step, text: f, rest: "" };
    }
    return undefined;
  };
  const asFloat = (n: LispNumber) => (n.int !== undefined ? Number(n.int) : n.float);
  // n1 + (n1 - n2), or n1 + the step, as integers while all are, as Lisp's arithmetic.
  const next = (n1: LispNumber, n2?: LispNumber): string => {
    const other = n2 ?? step;
    if (n1.int !== undefined && other.int !== undefined) return numberString({ int: n2 ? n1.int + (n1.int - other.int) : n1.int + other.int });
    return numberString({ float: n2 ? asFloat(n1) + (asFloat(n1) - asFloat(other)) : asFloat(n1) + asFloat(other) });
  };
  const days = (ts: string) => {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(ts)!;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  };
  // As org-timestamp-up-day moves it in a buffer holding the field, point
  // left at its end by the insertion: the last timestamp, or a range's end.
  const shift = (t1: string, t2?: string) =>
    withTempBuffer(() => {
      e8.insert(t1);
      e8.callWithPrefix(t2 === undefined ? Number(asFloat(step)) : days(t1) - days(t2), "org-timestamp-up-day");
      return e8.bufferText(e8.pointMin(), e8.pointMax());
    });
  const a = analyze(field);
  const b = analyze(previous);
  if (!a) return field;
  const same = b !== undefined && b.type === a.type;
  if (a.type === "number") return next(a.n, same ? b!.n : undefined);
  if (a.type === "prefix") return next(a.n, same && b!.rest === a.rest ? b!.n : undefined) + a.rest;
  if (a.type === "suffix") return a.rest + next(a.n, same && b!.rest === a.rest ? b!.n : undefined);
  return shift(a.text, same ? b!.text : undefined);
}

/**
 * Copies the field at point to the row below and moves there, or fills an
 * empty field from the nearest field above with something in it, the Nth
 * with N, as org-table-copy-down does, moving it on by
 * org-table-copy-increment unless N is 0.
 */
function copyDown(n: number): void {
  checkInsideDataField();
  const beg = tableBegin();
  const column = currentColumn();
  const fieldAt = (line: number): string => {
    const p = e8.point();
    e8.gotoChar(e8.lineStart(line));
    const f = getField(column);
    e8.gotoChar(p);
    return f;
  };
  const here = getFieldHere();
  const initial = nonWhite(here) ? orgTrim(here) : undefined;
  let field = initial;
  // The line the field above the one copied is read from.
  let from = lineAt();
  if (field === undefined) {
    let count = n;
    for (let l = lineAt() - 1; l >= 0 && e8.lineStart(l) >= beg; l--) {
      if (!DATALINE.test(e8.lineText(l))) continue;
      const f = fieldAt(l);
      if (!nonWhite(f)) continue;
      if (count > 1) {
        count--;
        continue;
      }
      field = orgTrim(f);
      from = l;
      break;
    }
    if (field === undefined) e8.userError("No non-empty field found");
  }
  let next: string | undefined;
  const option = e8.variable("org-table-copy-increment");
  if (option !== null && option !== undefined && option !== false && n !== 0) {
    let above: string | undefined;
    // Read whatever that line holds, a rule's dashes included, as org-table-get-field reads it.
    if (typeof option !== "number" && e8.lineStart(from) !== beg) {
      const f = fieldAt(from - 1);
      above = nonWhite(f) ? orgTrim(f) : undefined;
    }
    next = incrementField(field!, above);
  }
  if (initial !== undefined) {
    // Not aligned first, as org-table-may-need-update is nil around it.
    nextRow(false);
    blankField();
  }
  e8.insert(next ?? field!);
  align();
}

/** The text of the field point is in, point kept. */
function getFieldHere(): string {
  const p = e8.point();
  const f = getField();
  e8.gotoChar(p);
  return f;
}

e8.defineCommand({
  name: "org-table-copy-down",
  doc:
    "Copy the field at point to the row below and move there, or fill an empty field from the nearest field above with something in it, " +
    "the Nth with a prefix argument; numbers and timestamps go up as org-table-copy-increment says, unless the argument is 0.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => copyDown(n),
});

/**
 * What org-table-maybe-eval-formula does before moving on from a field,
 * as E8 has no formulas: it reads the field, which leaves point near
 * the field's start.
 */
function maybeEvalFormula(): void {
  getField();
}

e8.defineCommand({
  name: "org-table-maybe-eval-formula",
  doc: "Evaluate the field at point if it is a formula. E8 does not support formulas yet, so this only reads the field.",
  run: () => maybeEvalFormula(),
});

/** The data lines of the table at point, in order. */
function dataLines(): number[] {
  const lines: number[] = [];
  for (let l = firstLine(); l <= lastLine(); l++) if (DATALINE.test(e8.lineText(l))) lines.push(l);
  return lines;
}

/** Which data line point is on, counting from 1, as org-table-current-line counts. */
function currentDataLine(): number {
  const p = e8.point();
  let count = 0;
  for (const l of dataLines()) {
    count++;
    if (e8.lineEnd(l) >= p) break;
  }
  return count;
}

function gotoDataLine(n: number): boolean {
  const lines = dataLines();
  if (n < 1 || n > lines.length) return false;
  e8.gotoChar(e8.lineStart(lines[n - 1]));
  return true;
}

/** How many fields the table's first data row has, as org-table-analyze counts them. */
function columnCount(): number {
  const lines = dataLines();
  if (lines.length === 0) return 0;
  return orgSplitString(e8.lineText(lines[0]), /[ \t]*\|[ \t]*/g).length;
}

/**
 * Splits a string at a separator, as org-split-string does: a separator at
 * the very start or end makes no empty piece, so a row of just "|" has none.
 */
function orgSplitString(text: string, separator: RegExp): string[] {
  const matches = allMatches(separator, text).filter((m) => m[0] !== "");
  if (matches.length === 0) return [text];
  const out: string[] = [];
  let i = 0;
  for (const m of matches) {
    const at = m.index ?? 0;
    if (!(at === 0 && i === 0)) out.push(text.slice(i, at));
    i = at + m[0].length;
  }
  if (i !== text.length) out.push(text.slice(i));
  return out;
}

/** Swaps the field at point with the one next to it, as org-table--move-cell does. */
function moveCell(dRow: number, dCol: number): void {
  checkInsideDataField();
  const row = currentDataLine();
  const column = currentColumn();
  const [targetRow, targetColumn] = [row + dRow, column + dCol];
  if (targetColumn < 1 || targetRow < 1 || targetColumn > columnCount() || targetRow > dataLines().length) {
    e8.userError("Cannot move cell further");
  }
  const get = (r: number, c: number): string =>
    saveExcursion(() => {
      gotoDataLine(r);
      return getField(c).trim();
    });
  const put = (r: number, c: number, value: string): void =>
    saveExcursion(() => {
      gotoDataLine(r);
      gotoColumn(c, false, true);
      getField(c, value);
    });
  const a = get(row, column);
  const b = get(targetRow, targetColumn);
  put(row, column, b);
  put(targetRow, targetColumn, a);
  gotoDataLine(targetRow);
  gotoColumn(targetColumn);
  align();
}

e8.defineCommand({
  name: "org-table-move-cell-up",
  doc: "Swap the field at point with the one above it.",
  run: () => moveCell(-1, 0),
});
e8.defineCommand({
  name: "org-table-move-cell-down",
  doc: "Swap the field at point with the one below it.",
  run: () => moveCell(1, 0),
});
e8.defineCommand({
  name: "org-table-move-cell-left",
  doc: "Swap the field at point with the one to its left.",
  run: () => moveCell(0, -1),
});
e8.defineCommand({
  name: "org-table-move-cell-right",
  doc: "Swap the field at point with the one to its right.",
  run: () => moveCell(0, 1),
});

/** Runs body at the start of each data row of the table, then goes back to the field point was in, as org-table-save-field does. */
function eachDataRow(body: () => void): void {
  const lineMark = marker(e8.lineStart(lineAt()));
  const column = currentColumn();
  const end = marker(tableEnd());
  try {
    for (let l = firstLine(); l < e8.lineCount() && e8.lineStart(l) < end.pos; l++) {
      e8.gotoChar(e8.lineStart(l));
      if (!atHline()) body();
    }
  } finally {
    e8.gotoChar(lineMark.pos);
    gotoColumn(column);
    dropMarker(lineMark);
    dropMarker(end);
  }
}

function moveColumn(left: boolean): void {
  tableHere();
  findDataline();
  checkInsideDataField(true);
  const col = currentColumn();
  const col1 = left ? col - 1 : col;
  const colpos = left ? col - 1 : col + 1;
  if (left && col === 1) e8.userError("Cannot move column further left");
  if (!left && /^[^|\n]*\|[^|\n]*$/.test(restOfLine())) e8.userError("Cannot move column further right");
  eachDataRow(() => {
    gotoColumn(col1, true);
    const m = /^\|([^|\n]+)\|([^|\n]+)\|/.exec(restOfLine());
    if (m) {
      const p = e8.point();
      const [len1, len2] = [charCount(m[1]), charCount(m[2])];
      const [start1, end1, start2, end2] = [p + 1, p + 1 + len1, p + 2 + len1, p + 2 + len1 + len2];
      // As transpose-regions does, markers in the fields go with their text.
      const moved = (x: number): number =>
        x < start1 || x >= end2 ? x : x < end1 ? x + len2 + 1 : x < start2 ? x + len2 - len1 : x - len1 - 1;
      const mark = e8.mark();
      const saved: [Marker, number][] = markers.map((k) => [k, moved(k.pos)]);
      edDelete(start1, end2);
      edInsert(start1, `${m[2]}|${m[1]}`);
      placeMarkers(saved);
      if (mark !== undefined) e8.setMark(moved(mark));
    }
  });
  gotoColumn(colpos);
  align();
}

e8.defineCommand({
  name: "org-table-move-column-left",
  doc: "Swap the column at point with the one to its left.",
  run: () => moveColumn(true),
});
e8.defineCommand({
  name: "org-table-move-column-right",
  doc: "Swap the column at point with the one to its right.",
  run: () => moveColumn(false),
});

/** Swaps the row at point with the one above or below it, as org-table-move-row does, without aligning. */
function moveRow(up: boolean): void {
  const col = currentColumnOfPoint();
  const pos = e8.point();
  if (up && e8.lineStart(lineAt()) === 0) e8.userError("Cannot move row further");
  forwardLine(up ? -1 : 1);
  if ((!up && e8.point() === e8.pointMax()) || !atTable()) {
    e8.gotoChar(pos);
    e8.userError("Cannot move row further");
  }
  e8.gotoChar(pos);
  const bol = e8.lineStart(lineAt());
  const row = edDelete(bol, lineStartOrEnd(lineAt() + 1));
  e8.gotoChar(bol);
  forwardLine(up ? -1 : 1);
  if (!atBol()) edInsert(e8.point(), "\n");
  edInsert(e8.point(), row);
  if (!atBol()) edInsert(e8.point(), "\n");
  forwardLine(-1);
  moveToColumn(col);
}

e8.defineCommand({
  name: "org-table-move-row-up",
  doc: "Swap the row at point with the one above it.",
  run: () => moveRow(true),
});
e8.defineCommand({
  name: "org-table-move-row-down",
  doc: "Swap the row at point with the one below it.",
  run: () => moveRow(false),
});

e8.defineCommand({
  name: "org-table-insert-row",
  doc: "Insert an empty row above the one at point, or below it with a prefix argument.",
  run: () => insertRow(e8.prefixArg() !== null),
});

e8.defineCommand({
  name: "org-table-kill-row",
  doc: "Kill the row at point, so C-y can put it back.",
  run: () => {
    tableHere();
    const col = currentColumnOfPoint();
    const line = lineAt();
    const [from, to] = [e8.lineStart(line), Math.min(e8.lineEnd(line) + 1, e8.bufferSize())];
    const mark = e8.mark();
    // Point after the mark, as Org passes them in order, so a kill joining
    // an earlier one goes after it.
    e8.setMark(from);
    e8.gotoChar(to);
    e8.call("kill-region");
    e8.setMark(mark === undefined ? null : mark >= to ? mark - (to - from) : mark > from ? from : mark);
    e8.gotoChar(from);
    if (!atTable()) forwardLine(-1);
    moveToColumn(col);
  },
});

e8.defineCommand({
  name: "org-table-insert-column",
  doc: "Insert an empty column to the left of the one at point.",
  run: () => {
    tableHere();
    if (e8.point() === e8.pointMax()) saveExcursion(() => edInsert(e8.point(), "\n"));
    if (!/\|[ \t]*$/.test(e8.lineText(lineAt()))) align();
    findDataline();
    const col = Math.max(1, currentColumn());
    saveExcursion(() => {
      const end = marker(tableEnd());
      for (let l = firstLine(); l < e8.lineCount() && e8.lineStart(l) < end.pos; l++) {
        e8.gotoChar(e8.lineStart(l));
        if (!atHline()) {
          gotoColumn(col, true);
          edInsert(e8.point(), "|");
        }
      }
      dropMarker(end);
    });
    gotoColumn(col);
    align();
  },
});

e8.defineCommand({
  name: "org-table-delete-column",
  doc: "Delete the column at point.",
  run: () => {
    tableHere();
    findDataline();
    // After the last field, the last column goes.
    if (/^[ \t]*$/.test(restOfLine())) {
      const before = beforeOnLine();
      e8.gotoChar(e8.lineStart(lineAt()) + charCount(before.slice(0, before.lastIndexOf("|"))));
    }
    checkInsideDataField(true);
    const col = currentColumn();
    eachDataRow(() => {
      gotoColumn(col, true);
      const m = /^\|[^|\n]+\|/.exec(restOfLine());
      if (m) {
        const p = e8.point();
        edDelete(p, p + charCount(m[0]));
        edInsert(p, "|");
      }
    });
    align();
  },
});

e8.defineCommand({
  name: "org-table-insert-hline",
  doc: "Insert a rule below the row at point, or above it with a prefix argument, as wide as the row's fields.",
  run: () => {
    tableHere();
    const above = e8.prefixArg() !== null;
    if (e8.point() === e8.pointMax()) saveExcursion(() => edInsert(e8.point(), "\n"));
    if (!/\|[ \t]*$/.test(e8.lineText(lineAt()))) align();
    let rule = cleanLine(e8.lineText(lineAt()));
    const col = currentColumnOfPoint();
    for (let m = /\|( +)\|/.exec(rule); m; m = /\|( +)\|/.exec(rule)) {
      rule = rule.slice(0, m.index) + "+" + "-".repeat(m[1].length) + "|" + rule.slice(m.index + m[0].length);
    }
    rule = rule.replace("+", "|");
    forwardLine(above ? 0 : 1);
    edInsert(e8.point(), `${rule}\n`);
    forwardLine(above ? 0 : -2);
    moveToColumn(col);
  },
});

e8.defineCommand({
  name: "org-table-wrap-region",
  doc: "Split the field at point, as M-RET does in a table: the text after point goes to the same field in the next row.",
  run: () => {
    checkInsideDataField();
    if (orgRegionActive()) throw new Error("Wrapping a region of a table is not supported yet");
    if (e8.variable("org-M-RET-may-split-line") === false) {
      const rest = restOfLine();
      const i = rest.search(/[|\r\n]/);
      e8.gotoChar(e8.point() + charCount(i < 0 ? rest : rest.slice(0, i)));
    }
    // As Org's looking-at, the field may run on past the line's end to the next bar.
    const m = /^([^|]+)\|/.exec(e8.bufferText(e8.point(), e8.bufferSize()));
    if (m) {
      const p = e8.point();
      edDelete(p, p + charCount(m[0]));
      edInsert(p, " |");
      e8.gotoChar(p);
      e8.call("org-table-next-row");
      e8.insert(`${m[1].trim()} `);
      align();
    } else e8.call("org-table-next-row");
  },
});

/** Copies a rectangle of fields, blanking them if cutting, as org-table-copy-region does. */
function copyRegion(cut: boolean): void {
  const region = orgRegionActive() && e8.mark() !== undefined;
  const mark = e8.mark() ?? e8.point();
  const [beg, end] = region ? [Math.min(mark, e8.point()), Math.max(mark, e8.point())] : [e8.point(), e8.point()];
  e8.gotoChar(beg);
  checkInsideDataField();
  const begLine = lineAt();
  const c01 = currentColumn();
  e8.gotoChar(end);
  checkInsideDataField(true);
  const endMark = marker(e8.lineEnd(lineAt()));
  const c02 = currentColumn();
  const [from, to] = [Math.min(c01, c02), Math.max(c01, c02)];
  const clip: string[][] = [];
  e8.gotoChar(e8.lineStart(begLine));
  // As in Org, point ends at the start of the line after the fields.
  while (e8.point() < endMark.pos) {
    if (!atHline()) {
      const row: string[] = [];
      for (let c = from; c <= to; c++) row.push(getField(c, cut ? "  " : undefined));
      clip.push(row);
    }
    forwardLine(1);
  }
  dropMarker(endMark);
  if (cut) align();
  tableClip = clip;
}

/** The fields last cut or copied from a table, as org-table-clip keeps them. */
let tableClip: string[][] = [];

e8.defineCommand({
  name: "org-table-paste-rectangle",
  doc: "Paste the fields last cut or copied from a table, starting at the field at point.",
  run: () => {
    if (tableClip.length === 0) e8.userError("First cut/copy a region to paste!");
    checkInsideDataField();
    const column = currentColumn();
    const realign = e8.variable("org-table-automatic-realign");
    e8.setVariable("org-table-automatic-realign", false);
    try {
      for (const row of tableClip) {
        for (const field of row) {
          getField(undefined, field);
          e8.call("org-table-next-field");
        }
        forwardLine(1);
        gotoColumn(column);
      }
    } finally {
      e8.setVariable("org-table-automatic-realign", realign ?? true);
    }
    align();
  },
});

e8.defineCommand({
  name: "org-table-cut-region",
  doc: "Blank the field at point, or the fields in the region, as cutting them does.",
  run: () => copyRegion(true),
});

e8.defineCommand({
  name: "org-table-copy-region",
  doc: "Copy the field at point, or the fields in the region.",
  run: () => copyRegion(false),
});

e8.defineCommand({
  name: "org-table-recalculate",
  doc: "Recalculate the table's formulas. E8 does not support table formulas yet, so with none this does nothing, as in Org.",
  run: () => tableHere(),
});

e8.defineCommand({
  name: "org-table-justify-field-maybe",
  doc: "Note whether the table at point needs aligning before moving on from a field, as TAB and RET do first.",
  run: () => justifyFieldMaybe(),
});


/** Rows laid out as an aligned table, for making a new one. */
function formatRows(indent: string, rows: Row[]): string[] {
  const data = rows.filter((r): r is string[] => r !== "hline");
  const n = Math.max(1, ...data.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...data.map((r) => e8.stringWidth(r[i] ?? ""))));
  const fraction = Number(e8.variable("org-table-number-fraction") ?? 0.5);
  const aligns = widths.map((_, i) => {
    const cells = data.map((r) => r[i] ?? "").filter((c) => c !== "");
    return cells.filter((c) => NUMBER.test(c)).length >= fraction * cells.length ? "r" : "l";
  });
  return rows.map(
    (r) =>
      indent +
      "|" +
      (r === "hline"
        ? widths.map((w) => "-".repeat(w + 2)).join("+")
        : widths.map((w, i) => alignField(r[i] ?? "", w, aligns[i])).join("|")) +
      "|",
  );
}

e8.defineCommand({
  name: "org-table-create-or-convert-from-region",
  doc:
    "Make a table: from the active region, splitting lines at tabs, else commas, else runs of spaces; " +
    "otherwise an empty one of a size read in the minibuffer, such as 3x2.",
  params: [{ name: "size", prompt: "Table size Columns x Rows [e.g. 5x2]: " }],
  run: (size) => {
    if (orgRegionActive()) {
      const mark = e8.mark() ?? e8.point();
      const from = e8.lineStart(e8.lineOf(Math.min(mark, e8.point())));
      const to = e8.lineEnd(e8.lineOf(Math.max(mark, e8.point())));
      const lines = e8.bufferText(from, to).split("\n");
      const separator = lines.some((l) => l.includes("\t"))
        ? /\t/
        : lines.every((l) => l.includes(",") || l.trim() === "")
          ? /,/
          : /\s+/;
      const rows: Row[] = lines.map((l) => l.trim().split(separator).map((f) => f.trim()));
      e8.deactivateMark();
      e8.deleteRegion(from, to);
      e8.gotoChar(from);
      e8.insert(formatRows("", rows).join("\n"));
      e8.gotoChar(from);
      gotoColumn(1);
      return;
    }
    const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/.exec(size === "" ? "5x2" : size);
    if (!match) throw new Error("Table size should be columns x rows, such as 5x2");
    const [cols, rowCount] = [Number(match[1]), Number(match[2])];
    const rows: Row[] = [];
    for (let r = 0; r < rowCount; r++) {
      rows.push(Array.from({ length: cols }, () => ""));
      if (r === 0 && rowCount > 1) rows.push("hline");
    }
    const line = e8.lineOf(e8.point());
    const indent = /^[ \t]*/.exec(e8.lineText(line))?.[0] ?? "";
    if (e8.lineText(line).trim() !== "") {
      e8.gotoChar(e8.lineEnd(line));
      e8.insert("\n");
    } else {
      e8.deleteRegion(e8.lineStart(line), e8.lineEnd(line));
      e8.gotoChar(e8.lineStart(line));
    }
    const start = e8.point();
    e8.insert(`${formatRows(indent, rows).join("\n")}\n`);
    e8.gotoChar(start);
    gotoColumn(1);
  },
});

/** The column of the table point is in, as org-table-current-column: the bars before it on its line, and on a rule the plusses too. */
function tableCurrentColumn(): number {
  const before = e8.bufferText(e8.lineStart(lineAt()), e8.point());
  const first = before.indexOf("|");
  if (first < 0) return 0;
  const rest = before.slice(first + 1);
  return 1 + (rest.match(atHline() ? /[+|]/g : /\|/g) ?? []).length;
}

e8.defineCommand({
  name: "org-table-hline-and-move",
  doc: "Insert a rule below the table's row and move to the row after it, or to a new one. With a prefix argument, to the same column.",
  params: [{ name: "sameColumn", kind: "prefix" }],
  run: (sameColumn: e8.PrefixArg) => {
    const col = tableCurrentColumn();
    e8.call("org-table-maybe-eval-formula");
    e8.call("org-table-insert-hline");
    // To the end of the rule's line, then into the row after it, or a new row if a rule follows.
    const line = lineAt() + 1;
    e8.gotoChar(line < e8.lineCount() ? e8.lineEnd(line) : e8.pointMax());
    if (/^\n[ \t]*\|-/.test(e8.bufferText(e8.point(), Math.min(e8.pointMax(), e8.point() + 200)))) {
      e8.insert("\n|");
      e8.call("org-table-align");
    } else e8.call("org-table-next-field");
    if (sameColumn !== null && sameColumn !== undefined) gotoColumn(col);
  },
});
