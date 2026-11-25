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
import { elementAt } from "org-element";
import { allMatches, charCount, forwardLine, getBufferWindow, truthy } from "subr";
import { fitWindowToBuffer, windowFullWidthP } from "window";

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

/**
 * Whether a position is in a table, as org-at-table-p: its line starts as a
 * row does and, in Org mode, the parser puts it in a table, so a `|` line
 * in a LaTeX environment or a block is none.
 */
export function atTable(pos = e8.point()): boolean {
  if (!isTableLine(lineAt(pos))) return false;
  if (!e8.derivedModeP("org-mode")) return true;
  // An Org table, not a table.el one, as org-at-table-p without its argument.
  for (let e = elementAt(pos); e; e = e.parent) if (e.type === "table") return e.tableType !== "table.el";
  return false;
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
  for (let l = firstLine(line); l <= lastLine(line); l++) rows.push(parseRow(e8.lineText(l)));
  return rows;
}

/** A table line's fields, without the blanks around them, or "hline" for a rule, as org-table-to-lisp reads a line. */
function parseRow(text: string): Row {
  let i = (/^[ \t]*/.exec(text)?.[0].length ?? 0) + 1;
  if (text[i] === "-") return "hline";
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
  return fields;
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
    : // The description up to the ]] that ends it, ] and all, as org-link-bracket-re takes it.
      field.replace(/\[\[((?:[^\]\\]|\\.)+)\](?:\[([\s\S]+?)\])?\]/g, (_m, link: string, desc?: string) => desc ?? link);
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
    // By the line's text, as org-table-align works from org-table-begin, not asking the parser.
    if (!isTableLine(lineAt())) e8.userError("Not at a table");
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

/** Moves to the start of the field point is in, or of the one before if at or before its start, after moving back n - 1 fields, as org-table-beginning-of-field. */
function beginningOfField(n: number): void {
  const pos = e8.point();
  for (; n > 1; n--) e8.call("org-table-previous-field");
  // Back to a bar on this line or the one before.
  const line = lineAt();
  const from = line > 0 ? e8.lineStart(line - 1) : e8.lineStart(line);
  const before = e8.bufferText(from, e8.point());
  const i = before.lastIndexOf("|");
  if (i < 0) e8.userError("No more table fields before the current");
  e8.gotoChar(from + charCount(before.slice(0, i)) + 1);
  if (charAt(e8.point()) === " ") e8.gotoChar(e8.point() + 1);
  if (e8.point() >= pos) beginningOfField(2);
}

/** Moves to the end of the field point is in, or of the one after if at or after its end, after moving on n - 1 fields, as org-table-end-of-field. */
function endOfField(n: number): void {
  const pos = e8.point();
  for (; n > 1; n--) e8.call("org-table-next-field");
  const rest = e8.bufferText(e8.point(), e8.lineEnd(lineAt()));
  const i = rest.indexOf("|");
  if (i >= 0) {
    e8.gotoChar(e8.point() + charCount(rest.slice(0, i)));
    e8.skipCharsBackward(" ");
    if (e8.point() > 0 && e8.bufferText(e8.point() - 1, e8.point()) === "|" && charAt(e8.point()) === " ") e8.gotoChar(e8.point() + 1);
  }
  if (e8.point() <= pos) endOfField(2);
}

e8.defineCommand({
  name: "org-table-beginning-of-field",
  doc: "Move to the start of the table field point is in, or of the one before if already there; with a prefix argument, back that many fields.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => beginningOfField(n),
});

e8.defineCommand({
  name: "org-table-end-of-field",
  doc: "Move to the end of the table field point is in, or of the one after if already there; with a prefix argument, on that many fields.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => endOfField(n),
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
type LispNumber = { int: bigint; float?: undefined } | { float: number; int?: undefined; nan?: string };

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
  if (Number.isNaN(x)) return n.nan ?? "0.0e+NaN";
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

/**
 * The table org-table-begin finds from point, as org-table-to-lisp reads it:
 * the lines from there that start with a bar, which outside a table may be
 * none.
 */
function orgTableToLisp(): Row[] {
  const rows: Row[] = [];
  for (let l = lineAt(orgTableBegin()); l < e8.lineCount() && e8.lineStart(l) <= e8.pointMax(); l++) {
    const text = e8.bufferText(e8.lineStart(l), Math.min(e8.lineEnd(l), e8.pointMax()));
    if (!/^[ \t]*\|/.test(text)) break;
    rows.push(parseRow(text));
  }
  return rows;
}

/** Which data line point is on, as org-table-current-line counts them from org-table-begin. */
function orgTableCurrentLine(): number {
  const pos = e8.point();
  const end = orgTableEnd();
  return saveExcursion(() => {
    e8.gotoChar(orgTableBegin());
    let count = 0;
    while (e8.reSearchForward("^[ \t]*|[^-]", { bound: end, noerror: true }) !== undefined) {
      count++;
      if (e8.lineEnd(lineAt()) >= pos) break;
    }
    return count;
  });
}

/** Goes to the nth data line, or after the last if there are fewer, as org-table-goto-line does. */
function orgTableGotoLine(n: number): void {
  e8.gotoChar(orgTableBegin());
  const end = orgTableEnd();
  let count = 0;
  while (e8.reSearchForward("^[ \t]*|[^-]", { bound: end, noerror: true }) !== undefined && ++count < n);
}

e8.defineCommand({
  name: "org-table-transpose-table-at-point",
  doc: "Transpose the table at point, its rows becoming its columns, as Org's does; its rules are dropped.",
  run: () => {
    const table = orgTableToLisp().filter((r): r is string[] => r !== "hline");
    const dlineOld = orgTableCurrentLine();
    const colOld = currentColumn();
    // A column of each row's field there, or "" for a row too short; as many as the first row has.
    const contents = (table[0] ?? []).map((_, i) => table.map((row) => row[i] ?? ""));
    e8.gotoChar(orgTableBegin());
    e8.reSearchForward("|");
    e8.gotoChar(e8.point() - 1);
    // Only the first line keeps the table's indentation, as in Org.
    e8.deleteRegion(e8.point(), orgTableEnd());
    e8.insert(contents.map((x) => `| ${x.join(" | ")}  |\n`).join(""));
    orgTableGotoLine(colOld);
    gotoColumn(dlineOld);
    if (contents.length === 0) {
      // With no rows, Org's align from here fails looking for a bar, and
      // does nothing off a table line.
      if (!e8.bufferText(e8.point(), e8.pointMax()).includes("|")) e8.signal("search-failed", 'Search failed: "|"', ['"|"']);
      if (!isTableLine(lineAt())) return;
    }
    align();
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
  tableClip = copyRegionBetween(beg, end, cut);
}

/** The fields of the rectangle from beg to end, row by row, blanked if cutting, as org-table-copy-region returns them. */
function copyRegionBetween(beg: number, end: number, cut: boolean): string[][] {
  [beg, end] = [Math.min(beg, end), Math.max(beg, end)];
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
  return clip;
}

/**
 * A field's number for summing, as org-table--number-for-summing reads it:
 * zero written with only signs, points and exponent letters is 0; a time
 * H:MM or H:MM:SS is a float of hours, counted in `times`; blanks, text
 * and anything else reading as the integer 0 are no number.
 */
function numberForSumming(field: string, times: { count: number }): LispNumber | undefined {
  const s = field.replace(/^ *\|? */, "").replace(/ *\|? *$/, "");
  if (s.includes("0") && /^[-+ \t0.edED]+$/.test(s)) return { int: 0n };
  if (/^[ \t]+$/.test(s)) return undefined;
  const time = /^([0-9]+):([0-9]+)(?::([0-9]+))?$/.exec(s);
  if (time) {
    times.count++;
    return { float: Number(time[1]) + Number(time[2]) / 60 + Number(time[3] ?? "0") / 3600 };
  }
  const n = stringToLispNumber(s);
  return n.int === 0n ? undefined : n;
}

/**
 * A string's leading number as string-to-number reads it, an integer or a
 * float, or the integer 0: after blanks, a sign, digits and a point, then an
 * exponent, or e+INF for an infinity or e+NaN for a NaN carrying the whole
 * digits, as Emacs prints it, 2.0e+NaN.
 */
function stringToLispNumber(text: string): LispNumber {
  const t = text.replace(/^[ \t]+/, "");
  const [mantissa, sign, lead, trail] = /^([+-]?)(\d*)(?:\.(\d*))?/.exec(t)!;
  if (!lead && !trail) return { int: 0n };
  const rest = t.slice(mantissa.length);
  const special = /^[eE]\+(INF|NaN)/.exec(rest);
  if (special?.[1] === "INF") return { float: sign === "-" ? -Infinity : Infinity };
  if (special) return { float: NaN, nan: `${sign === "-" ? "-" : ""}${BigInt(lead || "0")}.0e+NaN` };
  return lispNumber(mantissa + (/^[eE][+-]?\d+/.exec(rest)?.[0] ?? ""));
}

/**
 * The sum of numbers as + adds them: from the first, so a lone -0.0 stays
 * one, integers exactly until the first float, then floats, a NaN keeping
 * the first NaN's sign and payload, as the hardware passes it on.
 */
function sumNumbers(numbers: LispNumber[]): LispNumber {
  let int = 0n;
  let float: number | undefined;
  let nan: string | undefined;
  numbers.forEach((n, i) => {
    if (n.float !== undefined && Number.isNaN(n.float)) nan ??= n.nan;
    if (float === undefined && n.int !== undefined) int += n.int;
    else if (i === 0) float = n.float!;
    else float = (float ?? Number(int)) + (n.int !== undefined ? Number(n.int) : n.float!);
  });
  if (float === undefined) return { int };
  return Number.isNaN(float) ? { float, nan } : { float };
}

/** A float rounded to a whole number as printf's %.0f rounds it, halves to even. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/** A number as printf's %0W.0f writes it: rounded halves to even, zero-padded to width after any sign, and -0 for a negative zero. */
function printfFloat(x: number, width: number): string {
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  // Every digit of a whole number, as printf writes even 1e21.
  const digits = BigInt(Math.abs(roundHalfEven(x))).toString();
  return sign + digits.padStart(width - sign.length, "0");
}

/** x modulo y as Emacs's mod takes floats: the remainder with y's sign. */
function floatMod(x: number, y: number): number {
  const r = x % y;
  return r !== 0 && (y < 0 ? r > 0 : r < 0) ? r + y : r;
}

/**
 * Sums the numbers in the region's rectangle of the table, or in point's
 * column, from its first data line to its last, as org-table-sum does: the
 * result, as hours, minutes and seconds if a field was a time, is put on
 * the kill ring and returned. With nlast, only the last nlast fields.
 */
export function tableSum(beg?: number, end?: number, nlast?: number, interactive = false): string {
  return saveExcursion(() => {
    if (beg === undefined || end === undefined) {
      if (orgRegionActive() && e8.mark() !== undefined) [beg, end] = [Math.min(e8.mark()!, e8.point()), Math.max(e8.mark()!, e8.point())];
      else {
        // Org's own searches, which outside a table find the next table down.
        const col = currentColumn();
        e8.gotoChar(orgTableBegin());
        if (e8.reSearchForward("^[ \t]*|[^-]", { noerror: true }) === undefined) e8.userError("No table data");
        gotoColumn(col);
        beg = e8.point();
        e8.gotoChar(orgTableEnd());
        if (e8.reSearchBackward("^[ \t]*|[^-]", { noerror: true }) === undefined) e8.userError("No table data");
        gotoColumn(col);
        end = e8.point();
      }
    }
    let items = copyRegionBetween(beg, end, false).flat();
    if (nlast !== undefined && nlast < items.length) items = items.slice(items.length - nlast);
    const times = { count: 0 };
    const numbers = items.map((f) => numberForSumming(f, times)).filter((n): n is LispNumber => n !== undefined);
    const res = sumNumbers(numbers);
    let sres: string;
    if (times.count === 0) sres = numberString(res);
    else {
      let diff = 3600 * (res.int !== undefined ? Number(res.int) : res.float);
      // As floor fails on an infinity or a NaN.
      if (!Number.isFinite(diff)) e8.signal("overflow-error", "Arithmetic overflow error", []);
      // floor gives integers, never a negative zero.
      const h = Math.floor(diff / 3600) + 0;
      diff = floatMod(diff, 3600);
      const m = Math.floor(diff / 60) + 0;
      diff = floatMod(diff, 60);
      sres = `${printfFloat(h, 0)}:${printfFloat(m, 2)}:${printfFloat(diff, 2)}`;
    }
    e8.killNew(sres);
    if (interactive)
      e8.message(
        `Sum of ${numbers.length} items: ${sres.padEnd(20)}     (${e8.whereIsInternal("yank")[0] ?? "M-x yank"} will insert result into buffer)`,
      );
    return sres;
  });
}

/** Where the table above point begins, as org-table-begin searches for it: after the last line before point not starting with a bar, or the accessible start. */
function orgTableBegin(): number {
  return saveExcursion(() =>
    e8.reSearchBackward("^[ \t]*[^| \t]", { noerror: true }) === undefined ? e8.pointMin() : (forwardLine(1), e8.point()),
  );
}

/** Where the table at point ends, as org-table-end searches for it: the next line not starting with a bar, or the accessible end. */
function orgTableEnd(): number {
  return saveExcursion(() => {
    if (e8.reSearchForward("^[ \t]*[^| \t]", { noerror: true }) !== undefined) return e8.matchBeginning(0)!;
    // A last line of blanks with no newline after it ends the table at its start.
    e8.gotoChar(e8.pointMax());
    e8.skipCharsBackward(" \t");
    return atBol() ? e8.point() : e8.lineEnd(lineAt());
  });
}

e8.defineCommand({
  name: "org-table-sum",
  doc:
    "Sum the numbers in the region's rectangle of a table, or in point's column, showing the sum and putting it on the kill ring. " +
    "If a field looks like a time, H:MM or H:MM:SS, the sum is a time too.",
  run: () => void tableSum(undefined, undefined, undefined, true),
});

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


e8.defineVariable({
  name: "org-table-default-size",
  doc: "The size C-c | offers for a new table, as columns x rows.",
  value: "5x2",
});

/** A string split at a regexp's matches, those at its very start and end ignored, as org-split-string. */
function splitString(text: string, separators: RegExp): string[] {
  const out: string[] = [];
  let i = 0;
  for (const m of allMatches(separators, text)) {
    const at = m.index ?? 0;
    if (!(at === 0 && out.length === 0 && i === 0)) out.push(text.slice(i, at));
    i = at + m[0].length;
  }
  if (i !== text.length || out.length === 0 && i === 0) out.push(text.slice(i));
  return out;
}

/** The number a string starts with, or 0, as string-to-number reads it. */
function stringToNumber(text: string): number {
  const m = /^[ \t\n]*([-+]?(?:\d+\.?\d*(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?))/i.exec(text);
  return m ? Number(m[1]) : 0;
}

e8.defineVariable({
  name: "org-table-convert-region-max-lines",
  doc: "The most lines org-table-convert-region will convert, so a large region does not hang the editor.",
  value: 999,
});

/**
 * How org-table-convert-region splits lines into fields: [4] at commas, as
 * CSV, [16] at tabs, [64] at a regexp read in the minibuffer, a number at
 * that many spaces or a tab, a string at that regexp; undefined guesses
 * tabs if every line has one, else commas, else runs of spaces, and
 * "babel-auto" guesses so too but splits a single line only at those.
 */
export type Separator = undefined | "babel-auto" | [number] | number | string | symbol;

/**
 * Turns the lines from beg0 to end0 into a table, as org-table-convert-region:
 * a bar starts each line and replaces each separator, and the table is aligned.
 */
export function convertRegion(beg0: number, end0: number, separator: Separator): void {
  const beg1 = Math.min(beg0, end0);
  const end1 = Math.max(beg0, end0);
  const max = e8.variable("org-table-convert-region-max-lines");
  // As > fails on what is no number.
  if (typeof max !== "number") e8.signal("wrong-type-argument", `Wrong type argument: number-or-marker-p, ${e8.prin1ToString(max ?? null)}`, [e8.intern("number-or-marker-p"), max ?? null]);
  if (linesBetween(beg1, end1) > max)
    e8.userError(e8.formatMessage("Region is longer than `org-table-convert-region-max-lines' (%s) lines; not converting", max));
  const listOf = (n: number) => Array.isArray(separator) && separator.length === 1 && separator[0] === n;
  if (listOf(64)) separator = e8.readString("Regexp for field separator: ", { history: "regexp-history" });
  e8.gotoChar(beg1);
  e8.gotoChar(e8.lineStart(lineAt()));
  const beg = marker(e8.point());
  e8.gotoChar(end1);
  if (atBol()) e8.gotoChar(Math.max(e8.pointMin(), e8.point() - 1));
  else e8.gotoChar(e8.lineEnd(lineAt()));
  const end = marker(e8.point());
  try {
    if (separator === undefined || separator === null || separator === "babel-auto") {
      e8.gotoChar(beg.pos);
      const has = (re: string) => e8.saveExcursion(() => e8.reSearchForward(re, { bound: end.pos, noerror: true }) !== undefined);
      if (!has("^[^\n\t]+$")) separator = [16];
      else if (!has("^[^\n,]+$")) separator = [4];
      else if (separator === "babel-auto" && linesBetween(beg.pos, end.pos) === 1) separator = "\\`a\\`";
      else separator = 1;
    }
    e8.gotoChar(beg.pos);
    if (listOf(4)) {
      // Org's CSV reading: a bar at each line's start and end, quotes taken off a field, commas made bars.
      while (e8.point() < end.pos) {
        if (atBol()) e8.insert("| ");
        else if (e8.lookingAt("[ \t]*$")) {
          lookAndReplace("[ \t]*$", " |");
          forwardLine(1);
        } else if (e8.lookingAt('[ \t]*"\\([^"\n]*\\)"')) {
          lookAndReplace('[ \t]*"\\([^"\n]*\\)"', "\\1", false);
          if (e8.lookingAt('"')) e8.insert('"');
        } else if (e8.lookingAt("[^,\n]+")) e8.gotoChar(e8.matchEnd(0)!);
        else if (e8.lookingAt("[ \t]*,")) lookAndReplace("[ \t]*,", " | ");
        else forwardLine(1);
      }
    } else {
      let re: string;
      if (listOf(16)) re = "^\\|\t";
      else if (typeof separator === "number" && Number.isInteger(separator)) {
        if (separator < 1) e8.userError("Number of spaces in separator must be >= 1");
        re = `^ *\\| *\t *\\| \\{${separator},\\}`;
      } else if (typeof separator === "string") re = `^ *\\|${separator}`;
      // As Org's, with a prefix argument of only -.
      else e8.signal("error", "This should not happen", ["This should not happen"]);
      while (e8.reSearchForward(re, { bound: end.pos, noerror: true }) !== undefined) e8.replaceMatch("| ", { literal: true, fixedCase: true });
    }
    e8.gotoChar(beg.pos);
    align();
  } finally {
    dropMarker(beg);
    dropMarker(end);
  }
}

/** How many lines there are from start to end, as count-lines: a last line without its newline counts, without reading the text. */
function linesBetween(start: number, end: number): number {
  if (end <= start) return 0;
  return lineAt(end) - lineAt(start) + (e8.charBefore(end) === "\n" ? 0 : 1);
}

/** Replaces what regexp matches at point, as looking-at and replace-match do. */
function lookAndReplace(regexp: string, replacement: string, literal = true): void {
  e8.lookingAt(regexp);
  e8.replaceMatch(replacement, { literal, fixedCase: true });
}

e8.defineCommand({
  name: "org-table-create-or-convert-from-region",
  doc:
    "Make a table: from the active region, splitting lines at tabs, else commas, else runs of spaces; " +
    "otherwise an empty one of a size read in the minibuffer, such as 3x2.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (orgRegionActive() && e8.mark() !== undefined) {
      // The raw prefix argument, - being the symbol, which is no separator.
      const separator: Separator = arg === null || arg === undefined ? undefined : arg === "-" ? e8.intern("-") : arg;
      convertRegion(e8.mark()!, e8.point(), separator);
      return;
    }
    // As org-table-create: a prefix argument is taken for the size, which
    // Org then fails on, as it is no string; else the size is read.
    if (arg !== null && arg !== undefined) {
      const shown = Array.isArray(arg) ? `(${arg[0]})` : String(arg);
      e8.signal("wrong-type-argument", `Wrong type argument: stringp, ${shown}`, [e8.intern("stringp"), arg]);
    }
    const fallback = String(e8.variable("org-table-default-size") ?? "5x2");
    const size = e8.readString(`Table size Columns x Rows [e.g. ${fallback}]: `, { default: fallback });
    // Split on x, whatever its case, ignoring one at either end, as org-split-string does; each part read as string-to-number reads it.
    const parts = splitString(size === "" ? fallback : size, / *x */gi);
    if (parts.length < 2) e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil", [e8.intern("stringp"), null]);
    const [cols, rowNumber] = [stringToNumber(parts[0]), stringToNumber(parts[1])];
    if (!Number.isInteger(cols) || cols < 0) e8.signal("wrong-type-argument", `Wrong type argument: wholenump, ${cols}`, [e8.intern("wholenump"), cols]);
    // As dotimes counts: rows while below the number.
    const rowCount = Math.max(0, Math.ceil(rowNumber));
    // As org-table-create: rows of empty fields indented to point's column,
    // after a line break at point unless only blanks come before it, then a
    // rule after the first row, and the table aligned around point.
    const pos = e8.point();
    const indent = " ".repeat(e8.currentColumn());
    const row = `${indent}|${"  |".repeat(cols)}\n`;
    if (/^[ \t]*$/.test(e8.bufferText(e8.lineStart(lineAt()), e8.point()))) e8.gotoChar(e8.lineStart(lineAt()));
    else e8.insert("\n");
    const first = e8.point();
    e8.insert(row.repeat(rowCount));
    e8.gotoChar(pos);
    if (rowCount > 1) {
      e8.gotoChar(e8.lineEnd(lineAt()));
      e8.insert("\n|-");
      e8.gotoChar(pos);
    }
    // Org aligns from point; on the line before the table, which is no
    // table line, its search for the table's bounds finds the new one;
    // with no rows made there is none, and its search for a bar fails.
    if (isTableLine(lineAt())) align();
    else if (rowCount === 0) {
      // From the start of point's line, where Org's align has gone by then.
      e8.gotoChar(e8.lineStart(lineAt(pos)));
      e8.signal("search-failed", 'Search failed: "|"', ['"|"']);
    }
    else {
      e8.gotoChar(rowCount > 1 && pos < first ? e8.lineStart(lineAt(pos) + 1) : first);
      align();
      // Left at the start of point's line, as Org's align leaves it there.
      e8.gotoChar(e8.lineStart(lineAt(pos)));
    }
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

// Editing a field in a buffer of its own, after org-table-edit-field: C-c `
// opens *Org Table Edit Field* with the field's text, C-c C-c puts it back.

e8.defineVariable({
  name: "org-table-use-standard-references",
  doc: "Whether field references are written as spreadsheets write them, as B3, rather than as @3$2: t always, from to read them only.",
  value: "from",
});

e8.defineVariable({
  name: "org-table-exit-follow-field-mode-when-leaving-table",
  doc: "Whether org-table-follow-field-mode turns itself off when point leaves the table.",
  value: true,
});

/** The field each edit buffer edits and the windows to go back to, as Org's org-field-marker and org-window-configuration, which keep script objects. */
const fieldEdits = new Map<string, { marker: e8.Marker; windows: e8.WindowConfiguration }>();

const EDIT_FIELD_BUFFER = "*Org Table Edit Field*";

/** A column number as letters, A for 1 and AA for 27, as org-number-to-letters writes it. */
function numberToLetters(n: number): string {
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The data lines up to and including point's, as org-table-current-dline counts them. */
function currentDline(): number {
  const pos = e8.point();
  return saveExcursion(() => {
    e8.gotoChar(orgTableBegin());
    let count = 0;
    while (e8.point() <= pos) {
      if (e8.lookingAt("^[ \t]*|[^-]")) count++;
      const before = e8.point();
      forwardLine(1);
      if (e8.point() === before) break;
    }
    return count;
  });
}

/** Opens the field at point in *Org Table Edit Field* in another window, as org-table-edit-field does without an argument. */
function editField(): void {
  const pos = e8.makeMarker(e8.point());
  const coord =
    e8.variable("org-table-use-standard-references") === true
      ? `${numberToLetters(tableCurrentColumn())}${currentDline()}`
      : `@${currentDline()}$${tableCurrentColumn()}`;
  const field = getField();
  const windows = e8.currentWindowConfiguration();
  e8.gotoChar(e8.markerPosition(pos)!);
  e8.call("switch-to-buffer-other-window", EDIT_FIELD_BUFFER);
  const old = fieldEdits.get(EDIT_FIELD_BUFFER);
  if (old) e8.deleteMarker(old.marker);
  e8.call("erase-buffer");
  e8.insert(`#\n# Edit field ${coord} and finish with C-c C-c\n#\n`);
  e8.letBind({ "org-inhibit-startup": true }, () => e8.call("org-mode"));
  e8.callWithPrefix(-1, "auto-fill-mode");
  e8.setVariable("truncate-lines", false);
  e8.setVariable("word-wrap", true);
  const p = e8.pointMax();
  e8.gotoChar(p);
  e8.insert(orgTrim(field));
  e8.removeTextProperty(p, e8.pointMax(), "invisible");
  e8.removeTextProperty(p, e8.pointMax(), "intangible");
  e8.gotoChar(p);
  e8.makeLocalVariable("org-finish-function");
  e8.setVariable("org-finish-function", "org-table-finish-edit-field");
  fieldEdits.set(EDIT_FIELD_BUFFER, { marker: pos, windows });
  e8.message("Edit and finish with C-c C-c");
}

e8.defun("org-table-finish-edit-field", () => {
  const edit = fieldEdits.get(e8.bufferName());
  if (!edit) e8.userError("No field is being edited here");
  const cb = e8.bufferName();
  e8.gotoChar(e8.pointMin());
  while (e8.reSearchForward("^#.*\n?", { noerror: true }) !== undefined) e8.replaceMatch("", { literal: true });
  while (e8.reSearchForward("[ \t]*\n[ \t\n]*", { noerror: true }) !== undefined) e8.replaceMatch(" ", { literal: true });
  const text = orgTrim(e8.bufferText(e8.pointMin(), e8.pointMax()));
  e8.setWindowConfiguration(edit!.windows);
  fieldEdits.delete(cb);
  e8.call("kill-buffer", cb);
  const buffer = e8.markerBuffer(edit!.marker);
  const window = buffer === undefined ? undefined : getBufferWindow(buffer);
  if (window !== undefined) e8.selectWindow(window);
  e8.gotoChar(e8.markerPosition(edit!.marker)!);
  e8.deleteMarker(edit!.marker);
  checkInsideDataField();
  getField(undefined, text);
  align();
  e8.message("New field value inserted");
});

e8.defineCommand({
  name: "org-table-edit-field",
  doc:
    "Edit the table field at point in a window of its own, finishing with C-c C-c. " +
    "With C-u, show the whole field where it is instead; with C-u C-u, turn org-table-follow-field-mode on or off.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (!atTable()) e8.userError("Not at a table");
    if (Array.isArray(arg) && arg[0] === 16) {
      e8.callWithPrefix(truthy(e8.variable("org-table-follow-field-mode")) ? -1 : 1, "org-table-follow-field-mode");
    } else if (arg !== null) {
      // The field's hidden parts shown, as removing its invisible and intangible properties.
      const b = saveExcursion(() => (e8.skipCharsBackward("^|"), e8.point()));
      const e = saveExcursion(() => (e8.skipCharsForward("^|\r\n"), e8.point()));
      e8.removeTextProperty(b, e, "invisible");
      e8.removeTextProperty(b, e, "intangible");
    } else editField();
  },
});

/** After each command in the table, the field point is in shown in the editor, as org-table-follow-fields-with-editor. */
function followFieldsWithEditor(): void {
  if (truthy(e8.variable("org-table-exit-follow-field-mode-when-leaving-table")) && !atTable()) {
    e8.callWithPrefix(-1, "org-table-follow-field-mode");
    return;
  }
  if (!atTable() || !/[^ \t]/.test(beforeOnLine()) || atHline() || /^[ \t]*$/.test(restOfLine())) return;
  const win = e8.selectedWindow();
  editField();
  if (windowFullWidthP()) fitWindowToBuffer();
  e8.selectWindow(win);
}

e8.defineMinorMode({
  name: "org-table-follow-field-mode",
  lighter: " TblFollow",
  doc: "Make the field editor window follow point through the table; leaving the table turns it off, as org-table-exit-follow-field-mode-when-leaving-table says.",
  onChange: (enabled) => {
    if (enabled) {
      e8.addHook("post-command-hook", followFieldsWithEditor, { local: true, append: true });
      return;
    }
    e8.removeHook("post-command-hook", followFieldsWithEditor, { local: true });
    if (e8.getBuffer(EDIT_FIELD_BUFFER) === undefined) return;
    const win = getBufferWindow(EDIT_FIELD_BUFFER);
    if (win !== undefined) e8.deleteWindow(win);
    const edit = fieldEdits.get(EDIT_FIELD_BUFFER);
    if (edit) e8.deleteMarker(edit.marker);
    fieldEdits.delete(EDIT_FIELD_BUFFER);
    e8.call("kill-buffer", EDIT_FIELD_BUFFER);
  },
});
