// Column view, after Emacs's org-colview.el: each heading of a subtree, or
// of the buffer, shown as a row of its properties' values, drawn over its
// line with overlays under a header line of the columns' titles, with
// values summarized up the tree as a column's operator says, and keys to
// edit them.

import {
  type Heading,
  selectiveGetter,
  allKeywords,
  bufferPropertyKeys,
  durationToMinutes,
  openLink,
  headingIndex,
  headings,
  propertyAllowedValues,
  reducedLevel,
  scanTags,
  subtreeEnd,
  today,
  todoFaceOf,
} from "org";
import { entryGet, entryPutHere, topGet } from "org-list";
import { linkDisplayFormat, linkUnescape } from "ol";
import { clockSpecialRange, clockSum } from "org-clock";
import { truthy } from "subr";

for (const [name, value, doc] of [
  ["org-columns-default-format", "%25ITEM %TODO %3PRIORITY %TAGS", "The columns column view shows where no COLUMNS property or #+COLUMNS: line says otherwise."],
  ["org-columns-checkbox-allowed-values", ["[ ]", "[X]"], "The values a column summarized with X, X/ or X% cycles through."],
  ["org-columns-modify-value-for-display-function", null, "A function given a column's title and a value, returning the text to show for it, or nil for the value as it is."],
  [
    "org-columns-summary-types",
    [],
    "Summary operators of your own, as [operator, function] or [operator, function, collect]: the function given the values and the printf format, the collect function the property, giving its value at a heading.",
  ],
  ["org-columns-ellipses", "..", "What ends a value too wide for its column."],
] as const) {
  e8.defineVariable({ name, value: value as unknown as e8.Value, doc });
}

/** A column, as org-columns-compile-format makes it: its property, title, width, summary operator and printf format. */
type Spec = { property: string; title: string; width?: number; op?: string; printf?: string };

/** A key telling specs apart, for the summaries kept on headings. */
// Not the width, which < and > change in place, as Org's spec, the summaries' key, is changed there.
const specKey = (s: Spec): string => JSON.stringify([s.property, s.title, s.op ?? null, s.printf ?? null]);

/** Column view's state in a buffer, as org-colview's buffer-local variables. */
type ColumnsState = {
  overlays: number[];
  global: boolean;
  fmt: string;
  compiled: Spec[];
  maxWidths: number[];
  begin: e8.Marker | undefined;
  topLevel: e8.Marker | undefined;
  previousHeader: e8.Value | undefined;
  previousTruncate: e8.Value | undefined;
  /** Whether flyspell-mode was on, to turn on again, as org-columns-flyspell-was-active. */
  flyspell?: boolean;
};

/** Each buffer's column view, by buffer id. */
const states = new Map<number, ColumnsState>();

function state(): ColumnsState {
  const id = e8.currentBuffer().id;
  // The killed buffers' states forgotten, their markers freed.
  if (!states.has(id)) {
    const live = new Set(e8.bufferList().map((b) => e8.getBuffer(b)?.id));
    for (const [other, st] of states) {
      if (live.has(other)) continue;
      if (st.begin) e8.deleteMarker(st.begin);
      if (st.topLevel) e8.deleteMarker(st.topLevel);
      states.delete(other);
    }
  }
  let s = states.get(id);
  if (!s) {
    s = { overlays: [], global: false, fmt: "", compiled: [], maxWidths: [], begin: undefined, topLevel: undefined, previousHeader: undefined, previousTruncate: undefined };
    states.set(id, s);
  }
  return s;
}

/** Turns a columns format into its columns, as org-columns-compile-format. */
export function compileFormat(fmt: string): Spec[] {
  const out: Spec[] = [];
  const re = /%([0-9]+)?([\p{L}\p{N}_-]+)(?:\(([^)]+)\))?(?:\{([^}]+)\})?\s*/gu;
  for (const m of fmt.matchAll(re)) {
    const width = m[1] === undefined ? undefined : Number(m[1]);
    const property = m[2].toUpperCase();
    const title = m[3] ?? m[2];
    let op = m[4];
    let printf: string | undefined;
    if (op !== undefined && op.includes(";")) [op, printf] = [op.slice(0, op.indexOf(";")), op.slice(op.indexOf(";") + 1)];
    out.push({ property, title, width, op, printf });
  }
  return out;
}

/** Turns columns back into their format, as org-columns-uncompile-format. */
export function uncompileFormat(compiled: Spec[]): string {
  return compiled
    .map((s) => {
      let out = `%${s.width ?? ""}${s.property}`;
      if (s.title !== s.property) out += `(${s.title})`;
      if (s.op !== undefined) out += s.printf !== undefined ? `{${s.op};${s.printf}}` : `{${s.op}}`;
      return out;
    })
    .join(" ");
}

// Durations as org-duration-from-minutes writes them.

const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, "0");
const lispMod = (a: number, b: number): number => a - b * Math.floor(a / b);

function hmm(minutes: number): string {
  return `${Math.trunc(minutes / 60)}:${pad2(lispMod(minutes, 60))}`;
}

/** MINUTES as org-duration-from-minutes writes them in FORMAT: h:mm, h:mm:ss, or the default, days then H:MM. */
function fromMinutes(minutes: number, format?: "h:mm" | "h:mm:ss"): string {
  if (minutes < 0) return `-${fromMinutes(-minutes, format)}`;
  if (format === "h:mm") return hmm(minutes);
  if (format === "h:mm:ss") return `${hmm(Math.floor(minutes))}:${pad2(lispMod(60 * minutes, 60))}`;
  if (minutes < 1440) return hmm(minutes);
  const days = 1440 * Math.floor(Math.floor(minutes) / 1440);
  return `${Math.floor(days / 1440)}d ${hmm(minutes - days)}`;
}

/** MINUTES as an age, in days, hours and minutes, as org-columns--format-age writes it. */
function formatAge(minutes: number): string {
  if (minutes < 0) return `-${formatAge(-minutes)}`;
  const parts: string[] = [];
  for (const [unit, size] of [["d", 1440], ["h", 60], ["min", 1]] as const) {
    if (size <= minutes) {
      const value = Math.floor(minutes / size);
      minutes -= value * size;
      parts.push(`${value}${unit}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : "0min";
}

/** Whether every time is H:MM or H:MM:SS, and which, as org-duration-h:mm-only-p. */
function hmmOnly(times: string[]): "h:mm" | "h:mm:ss" | undefined {
  let hms = false;
  for (const t of times) {
    if (!/^[ \t]*[0-9]+(?::[0-9]{2}){1,2}[ \t]*$/.test(t)) return undefined;
    if (/^[ \t]*[0-9]+:[0-9]{2}:[0-9]{2}[ \t]*$/.test(t)) hms = true;
  }
  return hms ? "h:mm:ss" : "h:mm";
}

/** A number in a string as Emacs's string-to-number reads it: its leading number, or 0. */
function stringToNumber(s: string): number {
  return readNumber(s).n;
}

/** A number as Emacs's string-to-number reads it, and whether it is a float: "1." and "seven" are integers, "1.5" and "1e3" floats. */
function readNumber(s: string): { n: number; float: boolean } {
  const m = /^[ \t\n]*([-+]?)([0-9]*)(\.[0-9]*)?(e[-+]?[0-9]+)?/i.exec(s)!;
  const digits = m[2];
  const fraction = m[3] !== undefined && m[3].length > 1;
  const exponent = m[4] !== undefined && (digits !== "" || fraction);
  if (digits === "" && !fraction) return { n: 0, float: false };
  const text = `${m[1]}${digits || "0"}${fraction ? m[3] : ""}${exponent ? m[4] : ""}`;
  return { n: Number(text), float: fraction || exponent };
}

/** A number formatted with PRINTF, as format does, or as %s prints it: integers as integers, floats with a point. */
function formatNumber(printf: string | undefined, x: { n: number; float: boolean }): string {
  if (printf !== undefined) return e8.format(printf, x.n);
  if (!x.float) return String(x.n);
  return Number.isInteger(x.n) ? `${x.n}.0` : String(x.n);
}

/** Numbers added as Emacs's + adds them, a float if any is. */
function sum(values: string[]): { n: number; float: boolean } {
  const xs = values.map(readNumber);
  return { n: xs.reduce((a, x) => a + x.n, 0), float: xs.some((x) => x.float) };
}

/** The greatest or least of numbers, the one that wins as it is, as Emacs's max and min give it. */
function extreme(values: string[], greatest: boolean): { n: number; float: boolean } {
  return values.map(readNumber).reduce((a, x) => ((greatest ? x.n > a.n : x.n < a.n) ? x : a));
}

/** A float rounded to the nearest integer, halves to even, as Emacs's round. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Minutes since a timestamp, or in a duration, as org-columns--age-to-minutes. */
function ageToMinutes(s: string): number {
  const ts = /<(\d{4})-(\d{2})-(\d{2})(?:[^>\d]*?(\d{1,2}):(\d{2}))?[^>]*>/.exec(s);
  if (ts) {
    const now = today(true);
    const at = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 60000;
    return at(now.year, now.month, now.day, now.hour ?? 0, now.minute ?? 0) - at(+ts[1], +ts[2], +ts[3], ts[4] === undefined ? 0 : +ts[4], ts[5] === undefined ? 0 : +ts[5]);
  }
  try {
    return durationToMinutes(s);
  } catch {
    return e8.userError(`Invalid age: ${JSON.stringify(s)}`);
  }
}

/** The summary of VALUES an operator gives, as org-columns-summary-types-default's functions. */
const SUMMARIES: Record<string, (values: string[], printf?: string) => string> = {
  "+": (v, p) => formatNumber(p, sum(v)),
  $: (v) => e8.format("%.2f", v.map(stringToNumber).reduce((a, b) => a + b, 0)),
  X: (v) => {
    const done = v.filter((b) => b === "[X]").length;
    return done === v.length ? "[X]" : done > 0 ? "[-]" : "[ ]";
  },
  "X/": (v) => `[${v.filter((b) => b === "[X]" || /\[([1-9])\/\1\]/.test(b)).length}/${v.length}]`,
  "X%": (v) => `[${roundEven((100 * v.filter((b) => b === "[X]" || b === "[100%]").length) / v.length)}%]`,
  max: (v, p) => formatNumber(p, extreme(v, true)),
  min: (v, p) => formatNumber(p, extreme(v, false)),
  mean: (v, p) => formatNumber(p, { n: sum(v).n / v.length, float: true }),
  ":": (v) => fromMinutes(v.map(durationToMinutes).reduce((a, b) => a + b, 0), hmmOnly(v)),
  ":max": (v) => fromMinutes(Math.max(...v.map(durationToMinutes)), hmmOnly(v)),
  ":min": (v) => fromMinutes(Math.min(...v.map(durationToMinutes)), hmmOnly(v)),
  ":mean": (v) => fromMinutes(v.map(durationToMinutes).reduce((a, b) => a + b, 0) / v.length, hmmOnly(v)),
  "@max": (v) => formatAge(Math.max(...v.map(ageToMinutes))),
  "@min": (v) => formatAge(Math.min(...v.map(ageToMinutes))),
  "@mean": (v) => formatAge(v.map(ageToMinutes).reduce((a, b) => a + b, 0) / v.length),
  "est+": (v) => {
    let mean = 0;
    let variance = 0;
    for (const e of v) {
      // An empty half as 0, as split-string keeps it.
      const parts = e.split("-").map(stringToNumber);
      if (parts.length === 2) {
        const [low, high] = parts;
        const m = (low + high) / 2;
        mean += m;
        variance += (low * low + high * high) / 2 - m * m;
      } else if (parts.length === 1) mean += parts[0];
    }
    const sd = Math.sqrt(variance);
    return `${e8.format("%.0f", mean - sd)}-${e8.format("%.0f", mean + sd)}`;
  },
};

/** The summary function and collect function of an operator, from org-columns-summary-types first, as org-columns--summarize. */
function operator(op: string): { summarize: (values: string[], printf?: string) => string; collect?: (property: string) => string | undefined } {
  const custom = e8.variable("org-columns-summary-types");
  for (const entry of Array.isArray(custom) ? custom : []) {
    if (!Array.isArray(entry) || entry[0] !== op) continue;
    const [, fn, collect] = entry;
    return {
      summarize: (values, printf) => String(e8.funcall(fn as string, values, printf ?? null) ?? ""),
      ...(collect !== undefined && collect !== null ? { collect: (p: string) => {
        const r = e8.funcall(collect as string, p);
        return typeof r === "string" ? r : undefined;
      } } : {}),
    };
  }
  const builtin = SUMMARIES[op];
  if (builtin === undefined) e8.signal("error", `Unknown "${op}" operator`);
  return { summarize: builtin };
}

/** The properties Org works out itself, which no operator summarizes, as org-special-properties. */
const SPECIAL = ["ALLTAGS", "BLOCKED", "CLOCKSUM", "CLOCKSUM_T", "CLOSED", "DEADLINE", "FILE", "ITEM", "PRIORITY", "SCHEDULED", "TAGS", "TIMESTAMP", "TIMESTAMP_IA", "TODO"];

/** The summaries kept on a heading's first character, as its org-summaries property. */
function summariesAt(pos: number): [string, string][] {
  const v = e8.getTextProperty(pos, "org-summaries");
  return Array.isArray(v) ? (v as [string, string][]) : [];
}

/**
 * Summarizes a column's values up the tree under the top-level heading,
 * as org-columns--compute-spec: each heading with values below it gets
 * their summary, and with UPDATE, a property it has is set to it.
 */
function computeSpec(s: ColumnsState, spec: Spec, update: boolean): void {
  const property = spec.property;
  const op = SPECIAL.includes(property) ? undefined : spec.op;
  if (op === undefined) return;
  const { summarize, collect } = operator(op);
  e8.saveRestriction(() => {
    e8.widen();
    const top = s.topLevel ? e8.markerPosition(s.topLevel) ?? 0 : 0;
    const all = headings();
    const ti = headingIndex(all, e8.lineOf(top));
    const end = ti !== undefined && all[ti].start === top ? subtreeEnd(all, ti) : e8.pointMax();
    const inTree = all.filter((h) => h.start >= top && h.start < end);
    const lmax = 29;
    const lvals: string[][] = Array.from({ length: lmax + 1 }, () => []);
    let level = 0;
    const inminlevel = lmax;
    let lastLevel = lmax;
    for (let k = inTree.length - 1; k >= 0; k--) {
      const h = inTree[k];
      if (level !== 0 && level !== inminlevel) lastLevel = level;
      level = reducedLevel(h.level);
      const value = collect ? e8.saveExcursion(() => (e8.gotoChar(h.start), collect(property))) : entryGet(h.line, property);
      const valueSet = value !== undefined && /\S/.test(value);
      if (level < lastLevel) {
        // Each level's values newest first, as Org pushes them.
        const values: string[] = [];
        for (let l = level + 1; l <= lmax; l++) for (let k = lvals[l].length - 1; k >= 0; k--) values.push(lvals[l][k]);
        const summary = values.length > 0 ? summarize(values, spec.printf) : undefined;
        if (summary !== undefined && summary !== "") {
          const list = summariesAt(h.start).filter(([key]) => key !== specKey(spec));
          list.push([specKey(spec), summary]);
          e8.withSilentModifications(() => e8.putTextProperty(h.start, h.start + 1, "org-summaries", list as unknown as e8.Value));
          const trimmed = summary.trim();
          // A property the heading has, even empty, takes the summary, as the first column of it says.
          if (update && value !== undefined && value !== trimmed) e8.saveExcursion(() => (e8.gotoChar(h.start), entryPutHere(property, trimmed)));
        }
        if ((summary !== undefined && summary !== "") || valueSet) lvals[level].push(summary !== undefined && summary !== "" ? summary : value!);
        for (let l = level + 1; l <= lmax; l++) lvals[l] = [];
      } else if (valueSet) lvals[level].push(value!);
    }
  });
}

/** Summarizes every column with an operator, as org-columns-compute-all; a property's value updated only by its first column. */
function computeAll(s: ColumnsState): void {
  e8.withSilentModifications(() => e8.removeTextProperty(e8.pointMin(), e8.pointMax(), "org-summaries"));
  const seen: string[] = [];
  for (const spec of s.compiled) {
    computeSpec(s, spec, !seen.includes(spec.property));
    seen.push(spec.property);
  }
}

/** A value as its column shows it, as org-columns--displayed-value: ITEM with its stars, dates as inactive, numbers by printf. */
function displayedValue(spec: Spec, value: string, h: Heading): string {
  const modify = e8.variable("org-columns-modify-value-for-display-function");
  // Only a function, as Org checks functionp.
  if (typeof modify === "function" || (typeof modify === "string" && e8.fboundp(modify))) {
    const r = e8.funcall(modify as string, spec.title, value);
    if (typeof r === "string") return r;
  }
  if (spec.property === "ITEM") {
    const lead = truthy(e8.variable("org-hide-leading-stars") ?? null) ? " " : "*";
    return `${lead.repeat(h.level - 1)}* ${linkDisplayFormat(value)}`;
  }
  if (["DEADLINE", "SCHEDULED", "TIMESTAMP"].includes(spec.property)) return value.replace(/<([0-9]{4}-[0-9]{2}-[0-9]{2}(?: [^>\n]*?)?)>/g, "[$1]");
  if (spec.printf === undefined) return value;
  return e8.format(spec.printf, stringToNumber(value));
}

/** Each column's spec, value and the value shown at heading H, as org-columns--collect-values. */
function collectValues(s: ColumnsState, h: Heading, get: (h: Heading, name: string) => string | undefined): [Spec, string, string][] {
  const summaries = summariesAt(h.start);
  return s.compiled.map((spec) => {
    const v = summaries.find(([key]) => key === specKey(spec))?.[1] ?? get(h, spec.property) ?? "";
    return [spec, v, displayedValue(spec, v, h)];
  });
}

/** STRING cut to WIDTH, as org-columns-add-ellipses ends it. */
function addEllipses(string: string, width: number): string {
  const ellipses = String(e8.variable("org-columns-ellipses") ?? "..");
  const cut = (str: string, w: number): string => {
    let out = "";
    for (const ch of str) {
      if (e8.stringWidth(out + ch) > w) break;
      out += ch;
    }
    return out;
  };
  if (e8.stringWidth(string) <= width) return string;
  if (width <= e8.stringWidth(ellipses)) return cut(ellipses, width);
  return cut(string, width - e8.stringWidth(ellipses)) + ellipses;
}

/** A value padded and cut to WIDTH, then " | " or " |" after it, as the format "%-W.Ws | " makes it. */
function cell(value: string, width: number, last: boolean): string {
  // In columns, as format counts its width and precision.
  let cutValue = "";
  for (const ch of value) {
    if (e8.stringWidth(cutValue + ch) > width) break;
    cutValue += ch;
  }
  return cutValue + " ".repeat(Math.max(0, width - e8.stringWidth(cutValue))) + (last ? " |" : " | ");
}

/** The face a value is shown in, as org-columns--overlay-text gives TODO, PRIORITY and TAGS theirs. */
function valueFace(property: string, original: string): e8.Value | undefined {
  if (property === "TODO") return todoFaceOf(original) ?? undefined;
  if (property === "PRIORITY") return "org-priority";
  if (property === "TAGS") return "org-tag";
  return undefined;
}

/** The keymap of the columns, as org-columns-map. */
const columnsMap = e8.defineKeymap("org-columns-map");

/** Draws the columns over the line at point, as org-columns--display-here. */
function displayHere(s: ColumnsState, columns: [Spec, string, string][]): void {
  e8.saveExcursion(() => {
    const line = e8.lineOf(e8.point());
    const bol = e8.lineStart(line);
    e8.gotoChar(bol);
    const level = /^(\*+) /.exec(e8.lineText(line))?.[1].length;
    const face = level !== undefined ? ["org-column", `org-level-${((level - 1) % 8) + 1}`] : ["org-column"];
    // As many characters on the line as columns, each column drawn over one.
    const chars = e8.lineEnd(line) - bol;
    if (columns.length > chars) {
      e8.saveExcursion(() => {
        e8.gotoChar(e8.lineEnd(line));
        // A change like any other, as Org inserts them.
        e8.letBind({ "inhibit-read-only": true }, () => e8.insert(" ".repeat(columns.length - chars)));
      });
    }
    columns.forEach(([spec, original, value], i) => {
      const width = s.maxWidths[i];
      const last = i === columns.length - 1;
      const shown = cell(addEllipses(value, width), width, last);
      const vf = valueFace(spec.property, original);
      const text = vf === undefined ? shown : e8.propertize(shown, { face: [vf, ...face] as e8.Value });
      const at = bol + i;
      const ov = e8.makeOverlay(at, at + 1, {
        face: face as e8.Value,
        display: vf === undefined ? e8.propertize(shown, { face: face as e8.Value }) : text,
        keymap: columnsMap,
        "org-columns-key": spec.property,
        "org-columns-value": original,
        "org-columns-value-modified": value,
        "line-prefix": "",
        "wrap-prefix": "",
      });
      s.overlays.push(ov);
    });
    // The rest of the line hidden.
    const after = bol + columns.length;
    const end = e8.lineEnd(line);
    if (after < end) s.overlays.push(e8.makeOverlay(after, end, { invisible: true, keymap: columnsMap, "line-prefix": "", "wrap-prefix": "" }));
    s.overlays.push(e8.makeOverlay(Math.max(bol, end - 1), Math.min(e8.pointMax(), end + 1), { keymap: columnsMap }));
    // Read-only from the end of the line before, as Org puts it, telling how to edit.
    e8.withSilentModifications(() =>
      e8.letBind({ "inhibit-read-only": true }, () =>
        e8.putTextProperty(Math.max(e8.pointMin(), bol - 1), Math.min(e8.pointMax(), end + 1), "read-only", "Type ‘e’ to edit property"),
      ),
    );
  });
}

/** Puts the columns' titles in the header line, as org-columns--display-here-title. */
function displayTitle(s: ColumnsState): void {
  const title = s.compiled.map((spec, i) => cell(spec.title || spec.property, s.maxWidths[i], false)).join("");
  if (s.previousHeader === undefined) s.previousHeader = e8.variable("header-line-format") ?? null;
  e8.makeLocalVariable("header-line-format");
  e8.setVariable(
    "header-line-format",
    e8.concat(e8.propertize(" ", { display: [Symbol.for("space"), Symbol.for(":align-to"), 0] as e8.Value }), e8.propertize(title.slice(0, -1), { face: "org-column-title" })),
  );
}

/** Takes the columns away, as org-columns-remove-overlays. */
function removeOverlays(s: ColumnsState): void {
  if (s.overlays.length === 0) return;
  if (s.previousHeader !== undefined) {
    e8.setVariable("header-line-format", s.previousHeader);
    s.previousHeader = undefined;
  }
  if (s.begin) e8.deleteMarker(s.begin);
  if (s.topLevel) e8.deleteMarker(s.topLevel);
  s.begin = undefined;
  s.topLevel = undefined;
  for (const ov of s.overlays) e8.deleteOverlay(ov);
  s.overlays = [];
  e8.withSilentModifications(() =>
    e8.letBind({ "inhibit-read-only": true }, () => e8.removeTextProperty(e8.pointMin(), e8.pointMax(), "read-only")),
  );
  if (s.previousTruncate !== undefined) {
    e8.setVariable("truncate-lines", s.previousTruncate);
    s.previousTruncate = undefined;
  }
  if (s.flyspell) {
    s.flyspell = false;
    e8.callWithPrefix(1, "flyspell-mode");
  }
}

/**
 * Where the rows go on from past a COMMENT or archived subtree, as
 * org-scan-tags's org-agenda-skip passes over them, as
 * org-agenda-skip-comment-trees and org-agenda-skip-archived-trees say.
 */
function skipper(): (h: Heading) => number | undefined {
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const archived = e8.variable("org-agenda-skip-archived-trees") ?? true;
  const comments = e8.variable("org-agenda-skip-comment-trees") ?? true;
  return (h) => {
    const skip = (truthy(comments) && /^COMMENT(?:[ \t]|$)/.test(h.title)) || (truthy(archived) && h.tags.includes(tag));
    if (!skip) return undefined;
    const all = headings();
    const i = headingIndex(all, h.line)!;
    let j = i + 1;
    while (j < all.length && all[j].level > h.level) j++;
    return all[j]?.start ?? e8.pointMax();
  };
}

/** The columns format here, as org-columns-get-format: given, a COLUMNS property inherited, a #+COLUMNS: line, or the default. */
function getFormat(s: ColumnsState, given?: string): string {
  const all = headings();
  const i = headingIndex(all, e8.lineOf(e8.point()));
  const inherited = i === undefined ? topGet("COLUMNS") : inheritedColumns(all, i)?.value;
  let fmt = given ?? inherited;
  if (fmt === undefined) {
    e8.saveRestriction(() => {
      e8.widen();
      // A keyword's, not a line in a block, as Org checks the element.
      let block: string | undefined;
      for (let l = 0; l < e8.lineCount() && fmt === undefined; l++) {
        const text = e8.lineText(l);
        if (block !== undefined) {
          if (new RegExp(`^[ \\t]*#\\+end_${block}[ \\t]*$`, "i").test(text)) block = undefined;
          continue;
        }
        const b = /^[ \t]*#\+begin_(\S+)/i.exec(text);
        if (b) {
          block = b[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          continue;
        }
        const m = /^[ \t]*#\+COLUMNS: (.+)$/i.exec(text);
        if (m) fmt = m[1].trim();
      }
    });
  }
  fmt ??= String(e8.variable("org-columns-default-format") ?? "");
  s.fmt = fmt;
  s.compiled = compileFormat(fmt);
  return fmt;
}

/** The COLUMNS property the heading at I has or inherits, and the heading it is on, as org-entry-get with inheritance and org-entry-property-inherited-from. */
function inheritedColumns(all: Heading[], i: number): { value: string; from: number } | undefined {
  let level = all[i].level + 1;
  for (let j = i; j >= 0; j--) {
    if (all[j].level >= level) continue;
    level = all[j].level;
    const v = entryGet(all[j].line, "COLUMNS");
    if (v !== undefined) return { value: v, from: all[j].start };
  }
  const top = topGet("COLUMNS");
  return top === undefined ? undefined : { value: top, from: 0 };
}

/** Goes to where column view starts, as org-columns-goto-top-level: the buffer's start before the first heading, the heading with the COLUMNS property, or the heading point is under. */
function gotoTopLevel(s: ColumnsState): void {
  const all = headings();
  const i = headingIndex(all, e8.lineOf(e8.point()));
  const pos = i === undefined ? e8.pointMin() : (inheritedColumns(all, i)?.from ?? all[i].start);
  if (s.topLevel) e8.deleteMarker(s.topLevel);
  s.topLevel = e8.makeMarker(pos);
  e8.gotoChar(pos);
}

/** Turns column view on, for the subtree point is in or with GLOBAL the buffer, as org-columns. */
export function columns(global: boolean, fmtString?: string): void {
  const s = state();
  removeOverlays(s);
  s.global = global;
  e8.saveExcursion(() => {
    if (global) e8.gotoChar(e8.pointMin());
    if (s.begin) e8.deleteMarker(s.begin);
    s.begin = e8.makeMarker(e8.point());
    gotoTopLevel(s);
    getFormat(s, fmtString);
    if (!inhibitRecalculation) computeAll(s);
    e8.saveRestriction(() => {
      const all = headings();
      const i = headingIndex(all, e8.lineOf(e8.point()));
      if (!global && i !== undefined && all[i].start === e8.point()) e8.narrowToRegion(e8.point(), Math.min(e8.pointMax(), subtreeEnd(all, i) + 1));
      if (s.compiled.some((c) => c.property === "CLOCKSUM")) clockSum();
      if (s.compiled.some((c) => c.property === "CLOCKSUM_T")) {
        const [start, end] = clockSpecialRange("today");
        clockSum(start, end, undefined, ":org-clock-minutes-today");
      }
      const get = selectiveGetter(true);
      const skip = skipper();
      const cache: (readonly [e8.Marker, [Spec, string, string][]])[] = [];
      try {
        scanTags((h) => cache.push([e8.makeMarker(h.start), collectValues(s, h, get)] as const), true, false, skip);
        if (cache.length === 0) return;
        s.maxWidths = s.compiled.map((spec, k) => {
          if (spec.width !== undefined) return spec.width;
          // In characters, as org-columns--set-widths takes length, though cells are padded in columns.
          let width = [...spec.title].length;
          for (const [, cols] of cache) width = Math.max(width, [...cols[k][2]].length);
          return width;
        });
        displayTitle(s);
        // Spelling not checked meanwhile, as Org turns flyspell-mode off.
        if (truthy(e8.variable("flyspell-mode") ?? null)) {
          s.flyspell = true;
          e8.callWithPrefix(0, "flyspell-mode");
        }
        if (!truthy(e8.variable("global-visual-line-mode") ?? null)) {
          if (s.previousTruncate === undefined) s.previousTruncate = e8.variable("truncate-lines") ?? null;
          e8.makeLocalVariable("truncate-lines");
          e8.setVariable("truncate-lines", true);
        }
        for (const [marker, cols] of cache) {
          e8.gotoChar(e8.markerPosition(marker) ?? 0);
          displayHere(s, cols);
        }
      } finally {
        for (const [marker] of cache) e8.deleteMarker(marker);
      }
    });
  });
}

/** While set, columns are drawn without summarizing again, as org-columns-inhibit-recalculation. */
let inhibitRecalculation = false;

/** Draws the columns again, as org-columns-redo, with RECALC whether to summarize again. */
function redo(recalc = true): void {
  const s = state();
  if (s.overlays.length === 0) return;
  e8.message("Recomputing columns...");
  const at = s.begin ? (e8.markerPosition(s.begin) ?? e8.point()) : e8.point();
  const [global, fmt] = [s.global, s.fmt];
  e8.saveExcursion(() => {
    e8.gotoChar(at);
    removeOverlays(s);
    const outer = inhibitRecalculation;
    inhibitRecalculation = !recalc;
    try {
      columns(global, fmt);
    } finally {
      inhibitRecalculation = outer;
    }
  });
  e8.message("Recomputing columns...done");
}

/** The column point is in, as org-current-text-column counts characters from the line's start. */
const textColumn = (): number => e8.point() - e8.lineStart(e8.lineOf(e8.point()));

/** A property of the column overlay at point, as get-char-property reads it. */
function columnProperty(name: string): e8.Value | undefined {
  for (const ov of e8.overlaysAt(e8.point())) {
    const v = e8.overlayGet(ov, name);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** The heading of point's line, for the column commands. */
function headingHere(): Heading {
  const all = headings();
  const i = headingIndex(all, e8.lineOf(e8.point()));
  if (i === undefined) e8.userError("Before first headline");
  return all[i];
}

/** Signals if the value at point is a summary, as org-columns-check-computed. */
function checkComputed(s: ColumnsState): void {
  const spec = s.compiled[textColumn()];
  if (spec?.op !== undefined && summariesAt(e8.lineStart(e8.lineOf(e8.point()))).some(([key]) => key === specKey(spec))) {
    e8.signal("error", "This value is computed from the entry\u2019s children");
  }
}

/** Runs F with the line made writable, then draws the columns again, summarizing again, as org-columns-edit-value does. */
function afterEdit(s: ColumnsState, f: () => void, col: number): void {
  const line = e8.lineOf(e8.point());
  e8.withSilentModifications(() =>
    e8.letBind({ "inhibit-read-only": true }, () => e8.removeTextProperty(Math.max(e8.pointMin(), e8.lineStart(line) - 1), e8.lineEnd(line), "read-only")),
  );
  // The entry folded again after, if a heading follows its line, as org-columns--call keeps headings' visibility.
  const bol = e8.lineStart(line);
  const hide = e8.lineEnd(line) !== e8.pointMax() && /^\*+ /.test(e8.lineText(line + 1));
  e8.letBind({ "inhibit-read-only": true }, () => {
    try {
      f();
    } finally {
      if (hide) e8.saveExcursion(() => (e8.gotoChar(bol), e8.call("outline-hide-entry")));
    }
  });
  redo(true);
  e8.gotoChar(Math.min(e8.lineStart(e8.lineOf(e8.point())) + col, e8.lineEnd(e8.lineOf(e8.point()))));
}

/** Replaces the title of the heading at point, trimmed, its keyword, priority and tags kept and aligned, as org-edit-headline; nothing for the same title. */
function editHeadline(title: string, old: string): void {
  title = title.trim();
  if (title === old) return;
  const line = e8.lineOf(e8.point());
  const text = e8.lineText(line);
  const keywords = allKeywords().map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const head = new RegExp(`^\\*+[ \t]+(?:(?:${keywords || "(?!)"})(?=[ \t]|$)[ \t]*)?(?:\\[#.\\][ \t]*)?`).exec(text)![0];
  const tail = /(?:[ \t]+:[\p{L}\p{N}_@#%:]+:)?[ \t]*$/u.exec(text.slice(head.length))![0];
  const start = e8.lineStart(line) + [...head].length;
  const end = e8.lineEnd(line) - [...tail].length;
  e8.deleteRegion(start, Math.max(start, end));
  e8.gotoChar(start);
  e8.insert(title);
  e8.call("org-align-tags");
}

/** Runs F at the heading of point's line, as org-with-point-at its marker. */
function atHeading<T>(h: Heading, f: () => T): T {
  return e8.saveExcursion(() => {
    e8.gotoChar(h.start);
    return f();
  });
}

function editValue(key?: string): void {
  const s = state();
  checkComputed(s);
  const col = textColumn();
  const h = headingHere();
  key ??= columnProperty("org-columns-key") as string | undefined;
  if (key === undefined) e8.userError("No column to edit at point");
  let action: (() => void) | undefined;
  if (key === "CLOCKSUM") e8.userError("This special column cannot be edited");
  else if (key === "ITEM") action = () => atHeading(h, () => editHeadline(e8.readString("Edit: ", { initial: h.title }), h.title));
  else if (key === "TODO") action = () => atHeading(h, () => e8.callInteractively("org-todo"));
  else if (key === "PRIORITY") action = () => atHeading(h, () => e8.callInteractively("org-priority"));
  else if (key === "TAGS") {
    action = () =>
      atHeading(h, () => {
        const single = e8.variable("org-fast-tag-selection-single-key");
        e8.letBind({ "org-fast-tag-selection-single-key": single === "expert" ? true : (single ?? null) }, () => e8.callInteractively("org-set-tags-command"));
      });
  } else if (key === "DEADLINE") action = () => atHeading(h, () => e8.callInteractively("org-deadline"));
  else if (key === "SCHEDULED") action = () => atHeading(h, () => e8.callInteractively("org-schedule"));
  else {
    const allowed = atHeading(h, () => propertyAllowedValues(key!));
    const value = String(columnProperty("org-columns-value") ?? "");
    const nval = (allowed === undefined
      ? e8.readString("Edit: ", { initial: value })
      : e8.completingRead("Value: ", allowed.values, { requireMatch: allowed.restricted })
    ).trim();
    if (nval !== value) action = () => atHeading(h, () => entryPutHere(key!, nval));
  }
  if (action === undefined) return;
  afterEdit(s, action, col);
}

/** The next or previous of the allowed values, or the Nth, for the column at point, as org-columns-next-allowed-value. */
function nextAllowedValue(previous = false, nth?: number): void {
  const s = state();
  checkComputed(s);
  const col = textColumn();
  const key = columnProperty("org-columns-key") as string | undefined;
  const value = String(columnProperty("org-columns-value") ?? "");
  const h = headingHere();
  const spec = s.compiled[col];
  let all = atHeading(h, () => propertyAllowedValues(key ?? ""))?.values
    ?? (spec?.op !== undefined && ["X", "X/", "X%"].includes(spec.op) ? (e8.variable("org-columns-checkbox-allowed-values") as string[]) : undefined)
    ?? allowedDates(value);
  if (previous && all) all = [...all].reverse();
  if (key === "ITEM") e8.signal("error", "Cannot edit item headline from here");
  if (!all && !["SCHEDULED", "DEADLINE", "CLOCKSUM"].includes(key ?? "")) e8.signal("error", "Allowed values for this property have not been defined");
  const l = all?.length ?? 0;
  let next: string;
  if (["SCHEDULED", "DEADLINE", "CLOCKSUM"].includes(key ?? "")) next = previous ? "earlier" : "later";
  else if (nth !== undefined) {
    if (Math.abs(nth) > l) e8.userError(`Only ${l} allowed values for property ‘${key}’`);
    next = all![lispMod(nth - 1, l)];
  } else if (all!.includes(value)) {
    if (l === 1) e8.signal("error", "Only one allowed value for this property");
    next = all![all!.indexOf(value) + 1] ?? all![0];
  } else next = all![0];
  afterEdit(s, () => atHeading(h, () => entryPutHere(key!, next)), col);
}

/** The day before, the day itself and the day after the timestamp S, in its form, as org-colview-construct-allowed-dates. */
function allowedDates(s: string): string[] | undefined {
  const m = /^([<[])(\d{4})-(\d{2})-(\d{2}) [^\]> ]+( \d{1,2}:\d{2})?([>\]])$/.exec(s);
  if (!m) return undefined;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return [-1, 0, 1].map((d) => {
    const t = new Date(Date.UTC(+m[2], +m[3] - 1, +m[4] + d));
    const date = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
    return `${m[1]}${date} ${names[t.getUTCDay()]}${m[5] ?? ""}${m[6]}`;
  });
}

/** Writes the format back, to the COLUMNS property it came from or a #+COLUMNS: line, as org-columns-store-format. */
function storeFormat(s: ColumnsState): void {
  const fmt = uncompileFormat(s.compiled);
  s.fmt = fmt;
  if (s.overlays.length === 0) return;
  e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      const top = s.topLevel ? (e8.markerPosition(s.topLevel) ?? 0) : 0;
      const all = headings();
      const i = headingIndex(all, e8.lineOf(top));
      e8.letBind({ "inhibit-read-only": true }, () => {
        if (i !== undefined && all[i].start === top && entryGet(all[i].line, "COLUMNS") !== undefined) {
          e8.gotoChar(top);
          entryPutHere("COLUMNS", fmt);
          return;
        }
        for (let l = 0; l < e8.lineCount(); l++) {
          const m = /^([ \t]*#\+COLUMNS:)(.*)$/i.exec(e8.lineText(l));
          if (m) {
            const start = e8.lineStart(l) + [...m[1]].length;
            e8.deleteRegion(start, e8.lineEnd(l));
            e8.gotoChar(start);
            e8.insert(` ${fmt}`);
            return;
          }
        }

        // None: one before the first heading.
        const first = headings()[0];
        e8.gotoChar(first ? first.start : e8.pointMax());
        e8.insertBeforeMarkers(`#+COLUMNS: ${fmt}\n`);
      });
      // The buffer's format, as Org sets it when the format goes to the buffer.
      if (!(i !== undefined && all[i].start === top && entryGet(all[i].line, "COLUMNS") !== undefined)) {
        e8.makeLocalVariable("org-columns-default-format");
        e8.setVariable("org-columns-default-format", fmt);
      }
    }),
  );
}

const cmd = (name: string, doc: string, run: (...args: e8.Value[]) => void, params?: Parameters<typeof e8.defineCommand>[0]["params"]) =>
  e8.defineCommand({ name, doc, run: run as never, ...(params ? { params } : {}) });

cmd(
  "org-columns",
  "Show the headings of the subtree point is in as a table of their properties, the columns COLUMNS, #+COLUMNS: or org-columns-default-format say; " +
    "before the first heading or with C-u, of the whole buffer.",
  (global) => columns(global !== null && global !== undefined),
  [{ name: "global", kind: "prefix" }],
);
cmd("org-columns-quit", "Leave column view.", () => {
  const s = state();
  removeOverlays(s);
  s.fmt = "";
});
cmd("org-columns-redo", "Draw the columns again, summarizing their values afresh.", () => redo(true));
cmd("org-columns-edit-value", "Edit the value of the column at point: TODO, priority, tags and dates with their own commands, others asked for.", () => editValue());
cmd("org-columns-todo", "Change the TODO state of the row at point.", () => editValue("TODO"));
cmd("org-columns-next-allowed-value", "Set the column at point to the next of its allowed values.", () => nextAllowedValue());
cmd("org-columns-previous-allowed-value", "Set the column at point to the previous of its allowed values.", () => nextAllowedValue(true));
cmd("org-columns-show-value", "Show the whole value of the column at point.", () => e8.message(`Value is: ${String(columnProperty("org-columns-value") ?? "")}`));
cmd("org-columns-toggle-or-columns-quit", "Toggle the checkbox at point, or leave column view.", () => {
  if (/^\[[ xX-]\]$/.test(String(columnProperty("org-columns-value") ?? ""))) nextAllowedValue();
  else e8.call("org-columns-quit");
});
cmd("org-columns-open-link", "Open the link in the column at point.", () => {
  // The first link in the value, as org-link-open-from-string opens it.
  const value = String(columnProperty("org-columns-value") ?? "");
  // At the value's start, as org-link-open-from-string parses it.
  const m = /^\[\[((?:[^\][\\]|\\.)+)\](?:\[([^\]]*)\])?\]/.exec(value);
  const plain = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^ \t\n()<>]+/.exec(value);
  if (m) openLink({ start: 0, end: 0, path: linkUnescape(m[1]), description: m[2], kind: "bracket" });
  else if (plain) openLink({ start: 0, end: 0, path: plain[0], kind: "plain" });
  else e8.userError(`No valid link in ${JSON.stringify(value)}`);
});
cmd("org-columns-content", "Show the headings, as CONTENTS does, in column view.", () => e8.call("org-content"));
cmd("org-columns-edit-allowed", "Edit the allowed values of the column at point's property.", () => {
  const s = state();
  const key = columnProperty("org-columns-key") as string | undefined;
  if (key === undefined) e8.userError("No column to edit at point");
  const h = headingHere();
  const all = headings();
  const i = headingIndex(all, h.line)!;
  const name = `${key}_ALL`;
  let from: number | undefined;
  for (let j = i, level = all[i].level + 1; j >= 0; j--) {
    if (all[j].level >= level) continue;
    level = all[j].level;
    if (entryGet(all[j].line, name) !== undefined) {
      from = all[j].start;
      break;
    }
  }
  const current = from === undefined ? undefined : entryGet(e8.lineOf(from), name);
  const value = e8.readString("Allowed: ", { initial: current });
  const at = from ?? (s.topLevel ? e8.markerPosition(s.topLevel) : undefined) ?? h.start;
  e8.letBind({ "inhibit-read-only": true }, () => e8.saveExcursion(() => (e8.gotoChar(at), entryPutHere(name, value))));
});
cmd(
  "org-columns-widen",
  "Make the column at point wider.",
  (arg) => {
    const s = state();
    const n = textColumn();
    s.compiled[n].width = Math.max(1, s.maxWidths[n] + Number(arg ?? 1));
    storeFormat(s);
    redo(false);
  },
  [{ name: "arg", kind: "count" }],
);
cmd(
  "org-columns-narrow",
  "Make the column at point narrower.",
  (arg) => e8.call("org-columns-widen", -Number(arg ?? 1)),
  [{ name: "arg", kind: "count" }],
);
cmd("org-columns-move-right", "Swap the column at point with the one to its right.", () => {
  const s = state();
  const n = textColumn();
  if (n >= s.compiled.length - 1) e8.signal("error", "Cannot shift this column further to the right");
  [s.compiled[n], s.compiled[n + 1]] = [s.compiled[n + 1], s.compiled[n]];
  storeFormat(s);
  redo(false);
  e8.gotoChar(e8.point() + 1);
});
cmd("org-columns-move-left", "Swap the column at point with the one to its left.", () => {
  if (textColumn() === 0) e8.signal("error", "Cannot shift this column further to the left");
  e8.gotoChar(e8.point() - 1);
  e8.call("org-columns-move-right");
  e8.gotoChar(e8.point() - 1);
});
for (const [name, up] of [["org-columns-move-row-down", false], ["org-columns-move-row-up", true]] as const) {
  cmd(name, `Move the row at point ${up ? "up" : "down"}, its subtree with it.`, () => {
    const col = textColumn();
    e8.letBind({ "inhibit-read-only": true }, () => e8.call(up ? "org-move-subtree-up" : "org-move-subtree-down"));
    // Summarized again, which gives what Org keeps in the text properties its move carries.
    redo(true);
    e8.gotoChar(Math.min(e8.lineStart(e8.lineOf(e8.point())) + col, e8.lineEnd(e8.lineOf(e8.point()))));
  });
}
for (const [name, dir] of [["org-columns-move-up", -1], ["org-columns-move-down", 1]] as const) {
  cmd(name, `Move to the row ${dir < 0 ? "above" : "below"}, in the same column.`, () => {
    const col = e8.currentColumn();
    let line = e8.lineOf(e8.point());
    do line += dir;
    while (line > 0 && line < e8.lineCount() - 1 && e8.invisibleP(e8.lineStart(line)));
    line = Math.max(0, Math.min(line, e8.lineCount() - 1));
    e8.gotoChar(e8.lineStart(line));
    e8.call("move-to-column", col);
  });
}

/** Reads a column's attributes, as org-columns-new asks for them. */
function readSpec(spec?: Spec): Spec {
  const property = e8.completingRead("Property: ", bufferPropertyKeys(), { initial: spec?.property });
  const title = e8.readString(`Column title [${property}]: `, { initial: spec?.title });
  const w = e8.readString("Column width: ", { initial: spec?.width === undefined ? undefined : String(spec.width) });
  const custom = e8.variable("org-columns-summary-types");
  const ops = ["", ...(Array.isArray(custom) ? custom.map((x) => String((x as e8.Value[])[0])) : []), ...Object.keys(SUMMARIES)];
  const op = e8.completingRead("Summary: ", [...new Set(ops)], { requireMatch: true, initial: spec?.op });
  const printf = e8.readString("Format: ", { initial: spec?.printf });
  return {
    // As typed, as org-columns-new keeps it.
    property,
    // An empty title kept, as Org stores it as %NAME().
    title,
    width: /\S/.test(w) ? stringToNumber(w) : undefined,
    op: /\S/.test(op) ? op : undefined,
    printf: /\S/.test(printf) ? printf : undefined,
  };
}

cmd("org-columns-new", "Add a column left of the one at point, its property, title, width, summary and format asked for.", () => {
  const s = state();
  s.compiled.splice(textColumn(), 0, readSpec());
  storeFormat(s);
  redo(true);
});
cmd("org-columns-edit-attributes", "Edit the property, title, width, summary and format of the column at point.", () => {
  const s = state();
  const n = textColumn();
  s.compiled[n] = readSpec(s.compiled[n]);
  storeFormat(s);
  redo(true);
});
cmd("org-columns-delete", "Remove the column at point.", () => {
  const s = state();
  const n = textColumn();
  const spec = s.compiled[n];
  if (!e8.yOrNP(`Are you sure you want to remove column ${JSON.stringify(spec.title)}? `)) return;
  s.compiled.splice(n, 1);
  storeFormat(s);
  redo(false);
  if (textColumn() >= s.compiled.length) e8.gotoChar(e8.point() - 1);
});

/** Summarizes PROPERTY again, as org-columns-compute. */
e8.defun("org-columns-compute", (property: string) => {
  const s = state();
  let main = true;
  for (const spec of s.compiled) {
    if (spec.property !== property.toUpperCase()) continue;
    computeSpec(s, spec, main);
    main = false;
  }
  return null;
});

for (const [key, command] of [
  ["c", "org-columns-content"],
  ["o", "org-overview"],
  ["e", "org-columns-edit-value"],
  ["C-c C-t", "org-columns-todo"],
  ["C-c C-c", "org-columns-toggle-or-columns-quit"],
  ["C-c C-o", "org-columns-open-link"],
  ["v", "org-columns-show-value"],
  ["q", "org-columns-quit"],
  ["r", "org-columns-redo"],
  ["g", "org-columns-redo"],
  ["<left>", "backward-char"],
  ["M-b", "backward-char"],
  ["a", "org-columns-edit-allowed"],
  ["s", "org-columns-edit-attributes"],
  ["M-f", "forward-char"],
  ["<right>", "forward-char"],
  ["<up>", "org-columns-move-up"],
  ["<down>", "org-columns-move-down"],
  ["S-<right>", "org-columns-next-allowed-value"],
  ["n", "org-columns-next-allowed-value"],
  ["S-<left>", "org-columns-previous-allowed-value"],
  ["p", "org-columns-previous-allowed-value"],
  ["<", "org-columns-narrow"],
  [">", "org-columns-widen"],
  ["M-<right>", "org-columns-move-right"],
  ["M-<left>", "org-columns-move-left"],
  ["M-<down>", "org-columns-move-row-down"],
  ["M-<up>", "org-columns-move-row-up"],
  ["S-M-<right>", "org-columns-new"],
  ["S-M-<left>", "org-columns-delete"],
] as const) {
  e8.bindKey(key, command, columnsMap);
}
// The digits pick the Nth allowed value, 0 the last, as Org's (mod -1 n) takes it.
for (let n = 0; n <= 9; n++) {
  const name = `org-columns-allowed-value-${n}`;
  e8.defineCommand({ name, doc: n === 0 ? "Set the column at point to its last allowed value." : `Set the column at point to allowed value number ${n}.`, run: () => nextAllowedValue(false, n) });
  e8.bindKey(String(n), name as e8.CommandName, columnsMap);
}
