// Capture, after Emacs's org-capture.el: a template's entry goes into its target
// file, which shows narrowed to it in a window of its own until C-c C-c
// files it or C-c C-k takes it away. Emacs captures in an indirect buffer;
// E8 narrows the target buffer itself.

import { bookmarkSet, jumpTo } from "bookmark";
import { alignTags, allowedValues, type DateTime, overridingDefaultTime, parseAllowedValues, formatTimestamp, globalTagsCompletionTable, type Heading, headingIndex, headings, isHeadingLine, killIsSubtree, parseDate, parseHeading, plistGet, readDateAnswer, shiftHeadings, stampFor, subtreeRegion, today, updateCheckboxCount, updateParentTodoStatistics, validLevel } from "org";
import { clockIn, clockOut, refreshClockHeading, runningClockLine, runningEntry } from "org-clock";
import { dateTreeRoot, findDateCreate } from "org-datetree";
import { ancestors, flag, showHeadingLine } from "org-fold";
import { insertLink, storeLink } from "ol";
import { completingReadMultiple } from "crm";
import { findBufferVisiting } from "files";
import { type Elem, elementAt, endBeforeBlank } from "org-element";
import { alphabetical, cycleListBullet, endOfMetaData, ITEM_RE } from "org-list";
import { lineAt, lineStartOrEnd, orgMks, titleWithoutCookies } from "org-macs";
import { charCount, forwardLine, getBufferWindow, truthy } from "subr";
import { atTable, currentDline, fixFormulas, fixFormulasConfirmed, getStoredFormulas, recalculate } from "org-table";

e8.defineVariable({
  name: "org-capture-templates",
  doc:
    "The capture templates: lists of a key, a description, the type (entry, item, checkitem, table-line or plain), a target such as " +
    '["file", NAME], ["id", ID], ["file+headline", NAME, HEADING], ["file+olp", NAME, HEADING, SUBHEADING...], ' +
    '["file+regexp", NAME, REGEXP], ["file+olp+datetree", NAME, HEADING...], ["file+function", NAME, FUNCTION], ' +
    '["function", FUNCTION] or ["clock"], the template text, and options such as ":tree-type", "week".',
  value: [],
});
for (const [name, doc] of [
  ["org-capture-before-finalize-hook", "Run before the capture is finished, in the capture's buffer, widened to the entire buffer."],
  ["org-capture-after-finalize-hook", "Run after the capture is finished and the windows are back as they were."],
  ["org-capture-prepare-finalize-hook", "Run before the capture is finished, as it begins to finish, in the capture's buffer."],
]) e8.defineHook(name, doc);
e8.defineVariable({
  name: "org-default-notes-file",
  doc: "The file capture templates with an empty file name file into.",
  value: "~/.notes",
});

type CaptureTemplate = [string, string, string, string[], string, ...e8.Value[]];

/** The templates, or Org's one default template if there are none. */
function captureTemplates(): CaptureTemplate[] {
  const value = e8.variable("org-capture-templates");
  if (Array.isArray(value) && value.length > 0) return value as unknown as CaptureTemplate[];
  return [["t", "Task", "entry", ["file+headline", "", "Tasks"], "* TODO %?\n  %u\n  %a"]];
}

/** How many blank lines go before or after a captured entry: the option, else :empty-lines, else none. */
function emptyLines(t: CaptureTemplate, name: string): number {
  const n = option(t, name) ?? option(t, ":empty-lines");
  return typeof n === "number" && n > 0 ? n : 0;
}

/** A template's option, as its properties plist gives it. */
function option(t: CaptureTemplate, name: string): e8.Value | undefined {
  const rest = t.slice(5);
  for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i] === name) return rest[i + 1];
  return undefined;
}

/** What %a and %i stand for: a link to where the capture started, and its active region. */
interface Context {
  annotation: string;
  initial: string;
  /** The tags of the target file, to complete %^g. */
  tags: string[];
  /** The capture's time, as :default-time: now, or the date a date tree asked for. */
  time?: DateTime;
  /** The target, where %^{PROP}p finds a property's allowed values. */
  target?: Target;
  /** The file the capture was started from, for %f and %F. */
  file?: string;
  /** The running clock's entry, its title and a link to it, for %k and %K. */
  clock?: { title: string; link: string };
}

/** A link to point's place for %a, as org-capture takes it from org-store-link, or nothing where there is none. */
function annotation(): string {
  // As ignore-errors: errors give none, but C-g still quits.
  return e8.conditionCase(
    () => {
      const link = storeLink(null, false);
      return typeof link === "string" ? link : "";
    },
    { error: () => "" },
  );
}

/**
 * Fills a template's escapes in one pass of REGEXP over TEXT, as
 * org-capture-fill-template does each kind: an escape after an odd number
 * of backslashes is left as written, and half the backslashes before it
 * go, as org-capture-escaped-% unescapes them, those an earlier
 * replacement ended with too, as Emacs searches the buffer it fills.
 * REPLACE gets the match and the line before it as filled so far.
 */
function fillPass(text: string, regexp: RegExp, replace: (m: RegExpExecArray, lineBefore: string) => string): string {
  let out = "";
  let last = 0;
  regexp.lastIndex = 0;
  for (let m = regexp.exec(text); m !== null; m = regexp.exec(text)) {
    let pending = out + text.slice(last, m.index);
    const n = /\\*$/.exec(pending)![0].length;
    pending = pending.slice(0, pending.length - Math.floor((n + 1) / 2));
    out = pending + (n % 2 === 1 ? m[0] : replace(m, /[^\n]*$/.exec(pending)![0]));
    last = m.index + m[0].length;
    if (m[0] === "") regexp.lastIndex++;
  }
  return out + text.slice(last);
}

/** A link's parts, as the template's %A, %l and %L take them from %a. */
const LINK = /\[\[(.*?)\](\[.*?\])?\]/;

/** Tabs as spaces to the next tab stop, as untabify makes them in an Org buffer: by display columns, every eight. */
function untabify(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let column = 0;
      for (const c of line) {
        if (c === "\t") {
          const pad = 8 - (column % 8);
          out += " ".repeat(pad);
          column += pad;
        } else {
          out += c;
          column += e8.stringWidth(c);
        }
      }
      return out;
    })
    .join("\n");
}

e8.defineVariable({ name: "org-capture--prompt-history", doc: "The history of the %^{prompt} being answered.", value: [] });
e8.defineVariable({ name: "org-capture--clipboards", doc: "The values %^C and %^L choose from.", value: [] });

/** Marks a line %^g put a heading's tags on, while the template is filled. */
const TAG_LINE = "\u0002";

/** Each %^{prompt}'s earlier answers, as org-capture--prompt-history-table. */
const promptHistory = new Map<string, string[]>();

/** The window system's selection, primary, clipboard or secondary, as org-get-x-clipboard: none without one. */
function selection(): string {
  for (const which of ["PRIMARY", "CLIPBOARD", "SECONDARY"]) {
    try {
      const v = e8.nsGetSelection(which);
      if (typeof v === "string" && v !== "") return v;
    } catch {
      // No window system, as in a terminal or batch.
    }
  }
  return "";
}

/** A file's text, read in a buffer of its own. */
function fileContents(name: string): string {
  const temp = e8.bufferName(e8.getBufferCreate(e8.generateNewBufferName(" *org capture file*"))) as string;
  try {
    return e8.withCurrentBuffer(temp, () => (e8.insertFileContents(name), e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())));
  } finally {
    e8.call("kill-buffer", temp);
  }
}

/** Runs BODY in a temporary Org buffer holding TEXT, as the *Capture* buffer the template is filled in, and returns its text. */
function inCaptureBuffer(text: string, body: () => void): string {
  const temp = e8.bufferName(e8.getBufferCreate(e8.generateNewBufferName(" *Capture*"))) as string;
  try {
    return e8.withCurrentBuffer(temp, () => {
      e8.insert(text);
      e8.call("org-mode");
      e8.gotoChar(e8.pointMin());
      body();
      return e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    });
  } finally {
    e8.call("kill-buffer", temp);
  }
}

/** A property's allowed values from org-global-properties alone, as org-property-get-allowed-values finds them outside an entry with no keywords. */
function globalAllowedValues(property: string): { values: string[]; restricted: boolean } {
  const key = `${property}_ALL`.toLowerCase();
  const user = e8.variable("org-global-properties");
  let all: string | undefined;
  if (Array.isArray(user)) {
    for (const e of user) if (Array.isArray(e) && typeof e[0] === "string" && e[0].toLowerCase() === key && typeof e[1] === "string") {
      all = e[1];
      break;
    }
  }
  return parseAllowedValues(all);
}

/** A link to VALUE as org-insert-link writes it, with no description, as %^L inserts it. */
function linkText(value: string): string {
  return inCaptureBuffer("", () => insertLink(0, value, undefined, false));
}

/**
 * A property's value read as org-read-property-value reads it, from its
 * allowed values where the target's entry, or the heading above where the
 * entry goes, has them.
 */
function readPropertyValue(property: string, dflt: string | undefined, target: Target | undefined, before: string): string {
  let allowed: { values: string[]; restricted: boolean } | undefined;
  // org-global-properties' first, as the template's buffer finds them, its #+PROPERTY: lines left out.
  const global = globalAllowedValues(property);
  if (global.values.length > 0) allowed = global;
  else if (target) {
    // The template's level: its first heading's, before where the escape is.
    const level = (/^(\*+) /m.exec(before) ?? /^(\*+) /m.exec(before + "\n"))?.[1].length ?? 1;
    allowed = e8.withCurrentBuffer(target.buffer, () =>
      e8.saveRestriction(() => {
        e8.widen();
        const all = headings();
        let i = headingIndex(all, lineAt(target.pos));
        if (!target.entryP) while (i !== undefined && all[i].level >= level) {
          let k = i - 1;
          while (k >= 0 && all[k].level >= all[i].level) k--;
          i = k >= 0 ? k : undefined;
        }
        // Before any heading, the file's own, its #+PROPERTY: lines and org-global-properties.
        const found = allowedValues(i === undefined ? undefined : all[i], property);
        return found.values.length > 0 ? found : undefined;
      }),
    );
  }
  // Without allowed values, the values the property has in the target, the default to start with; with
  // them, neither, as org-read-property-value keeps the default only when it is one of them, which its
  // test never finds.
  const values = allowed?.values ?? (target ? e8.withCurrentBuffer(target.buffer, () => (e8.derivedModeP("org-mode") ? (e8.funcall("org--property-values", property) as string[]) : [])) : []);
  return e8.letBind({ "completion-ignore-case": true }, () =>
    e8.completingRead(`${property} value: `, values ?? [], { requireMatch: allowed !== undefined && allowed.restricted, initial: allowed ? undefined : dflt }),
  );
}

/** Sets the properties %^{PROP}p read where their marks are in TEXT, on the template's entry there, as org-set-property. */
function setTemplateProperties(text: string, properties: [string, string, boolean][]): string {
  return inCaptureBuffer(text, () => {
    for (let n = 0; n < properties.length; n++) {
      const mark = `\u0001${n}\u0001`;
      const found = e8.search(mark, { from: e8.pointMin() });
      if (!found) continue;
      e8.deleteRegion(found.start, found.end);
      e8.gotoChar(found.start);
      if (properties[n][2]) {
        // Up to the top heading, as (while (org-up-heading-safe)) goes.
        const all = headings();
        let i = headingIndex(all, lineAt());
        while (i !== undefined) {
          let k = i - 1;
          while (k >= 0 && all[k].level >= all[i].level) k--;
          if (k < 0) break;
          i = k;
        }
        if (i !== undefined) e8.gotoChar(all[i].start);
      }
      e8.call("org-set-property", properties[n][0], properties[n][1]);
    }
  });
}

/**
 * A template's text with its escapes filled in, as org-capture-fill-template
 * does: first %<format>, %:keyword and the letters (%a, %A, %c, %f, %F, %i,
 * %k, %K, %l, %L, %n, %t, %T, %u, %U, %x), then in turn what %^ asks for
 * (%^{prompt|default|choice...}, %^g, %^G, %^t, %^T, %^u, %^U, %^C), then
 * %\N for the Nth answer, all ignoring case as Emacs's search does; then no
 * blank lines first and a newline last, and tabs untabified, %? still in it,
 * and where %? is the cursor goes. Also the lines %^g put tags on.
 */
function fillTemplate(template: string, context: Context = { annotation: "", initial: "", tags: [] }): { text: string; cursor?: number; tagLines: number[] } {
  let now = context.time ?? today(true);
  // Before org-extend-today-until, the day before at 23:59, as org-capture-fill-template has it.
  const extend = Number(e8.variable("org-extend-today-until") ?? 0);
  if ((now.hour ?? 0) < extend) {
    const t = new Date(Date.UTC(now.year, now.month - 1, now.day - 1));
    now = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: 23, minute: 59 };
  }
  const day = { year: now.year, month: now.month, day: now.day };
  // The time now, or noon on a fixed day, as tests fix org-current-effective-time.
  const fixed = typeof e8.variable("e8--today") === "string" && e8.variable("e8--today") !== "";
  const time = fixed || context.time !== undefined ? e8.encodeTime([0, now.minute ?? 0, now.hour ?? 0, now.day, now.month, now.year]) : e8.currentTime();
  const a = context.annotation === "[[]]" ? "" : context.annotation;
  let kill = "";
  try {
    kill = e8.currentKill(0);
  } catch {
    // An empty kill ring, as Emacs's (and kill-ring (current-kill 0)).
  }
  const letters: Record<string, () => string> = {
    a: () => a,
    A: () => (LINK.test(a) ? a.replace(LINK, (_m, l: string) => `[[${l}][%^{Link description}]]`) : a),
    l: () => (LINK.test(a) ? a.replace(LINK, (_m, l: string) => `[[${l}]]`) : a),
    L: () => (LINK.test(a) ? a.replace(LINK, (_m, l: string) => l) : a),
    c: () => kill,
    f: () => (context.file === undefined ? "" : e8.fileNameNondirectory(context.file)),
    F: () => context.file ?? "",
    k: () => context.clock?.title ?? "",
    K: () => context.clock?.link ?? "",
    n: () => String(e8.variable("user-full-name") ?? ""),
    t: () => `<${formatTimestamp(day, false)}>`,
    T: () => `<${formatTimestamp(now, true)}>`,
    u: () => `[${formatTimestamp(day, false)}]`,
    U: () => `[${formatTimestamp(now, true)}]`,
    x: () => selection(),
  };
  // The link's properties, as org-capture puts them on org-store-link-plist for %:keyword.
  const plist = (e8.variable("org-store-link-plist") ?? []) as e8.Value[];
  // %[file] first: the file's contents, as org-capture-fill-template inserts them.
  let text = fillPass(template, /%\[(.+)\]/g, (m) => {
    const name = e8.expandFileName(m[1]);
    // The error as Lisp prints it, its condition and data, as Org formats it with %s.
    return e8.conditionCase(
      () => fileContents(name),
      { error: (err) => `%![could not insert ${name}: (${[err.symbol, ...err.data.map((x) => (typeof x === "string" ? x : String(x)))].join(" ")})]` },
    );
  });
  text = fillPass(text, /%(:[-A-Za-z]+|<([^>\n]+)>|[aAcfFikKlLntTuUx])/gi, (m, lineBefore) => {
    const value = m[1];
    if (value.startsWith("<")) return e8.formatTimeString(m[2], time);
    // As org-store-link-plist holds them for the capture.
    if (value.startsWith(":")) {
      if (value === ":annotation") return a;
      if (value === ":initial") return context.initial;
      const v = plistGet(plist, value);
      return typeof v === "string" ? v : "";
    }
    // Each line after the first starts as the line %i is on does.
    if (value === "i") return context.initial.replace(/\n/g, () => `\n${lineBefore}`);
    // %I and the other capitals no letter is, as Emacs's case-folding search finds them and fails.
    const fill = letters[value];
    if (!fill) return e8.signal("wrong-type-argument", "Wrong type argument: char-or-string-p, nil");
    return fill();
  });
  const strings: string[] = [];
  const tagLines: number[] = [];
  const properties: [string, string, boolean][] = [];
  text = fillPass(text, /%\^(?:\{([^}]*)\})?([CgGLptTuU])?/gi, (m, lineBefore) => {
    const items = m[1] === undefined ? undefined : m[1].split("|");
    const prompt = items?.[0];
    const dflt = items?.[1];
    const key = m[2];
    if (key === "g" || key === "G") {
      // %^G every agenda file's tags, %^g the target file's, as org-global-tags-completion-table.
      const table = key === "G" ? globalTagsCompletionTable().map(([t]) => t) : context.tags;
      const answers = e8.letBind({ "crm-separator": "[ \t]*:[ \t]*" }, () =>
        completingReadMultiple(prompt !== undefined ? `${prompt}: ` : "Tags: ", table, { history: "org-tags-history" }),
      );
      const tags = answers.filter((t) => t !== "").join(":");
      if (tags === "") return "";
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
      // A heading's tags are aligned, as org-capture-fill-template aligns them where it puts them:
      // its line marked, to find once drawers and trimming have moved the lines.
      // Only tags that end the line are tags to align.
      const rest = text.slice(m.index + m[0].length).split("\n")[0];
      const mark = /^\*+ /.test(lineBefore) && /^:?[ \t]*$/.test(rest) ? TAG_LINE : "";
      return `${lineBefore.endsWith(":") ? "" : ":"}${tags}${after === ":" ? "" : ":"}${mark}`;
    }
    if (key === "C" || key === "L") {
      // The region, the selection and the latest kill, chosen from when there are more than one.
      const x = selection();
      const clipboards = [context.initial, ...(x !== "" ? [x] : []), ...(kill !== "" ? [kill] : [])];
      const value =
        clipboards.length === 1
          ? clipboards[0]
          : e8.letBind({ "org-capture--clipboards": clipboards }, () =>
              e8.readString("Clipboard/kill value: ", { initial: clipboards[0], default: clipboards[0], history: "org-capture--clipboards" }),
            );
      // %^L as a link, as org-insert-link makes one from it.
      return key === "C" ? value : linkText(value);
    }
    if (key === "p") {
      // Read now, set on the template's entry once the pass is over, as org-set-property does there.
      const property = prompt ?? "";
      const value = readPropertyValue(property, dflt, context.target, text.slice(0, m.index));
      // Outside an entry to file under, Org has gone up to the template's top heading, where it sets it.
      properties.push([property, value, context.target !== undefined && !context.target.entryP]);
      return `\u0001${properties.length - 1}\u0001`;
    }
    if (key === "t" || key === "T" || key === "u" || key === "U") {
      const upcase = key === "T" || key === "U";
      const answer = readDateAnswer(`${prompt !== undefined ? `${prompt} ` : ""}Date${upcase ? "+time" : ""}: `);
      // With a range's end time, as org-end-time-was-given is bound there.
      return stampFor(parseDate(answer, upcase, undefined, true), key === "t" || key === "T");
    }
    // Keys in other cases, as a case-folding search finds them, are none Org knows.
    if (key !== undefined) e8.signal("error", `Unknown template placeholder: "%^${key}"`);
    const label = prompt ?? "Enter string";
    // Each prompt's own history, as org-capture--prompt-history-table keeps them.
    const answer = e8.letBind({ "org-capture--prompt-history": promptHistory.get(prompt ?? "") ?? [] }, () => {
      const a = e8.completingRead(dflt !== undefined && dflt !== "" ? `${label} (default ${dflt}): ` : `${label}: `, items?.slice(2) ?? [], {
        default: dflt,
        history: "org-capture--prompt-history",
      });
      promptHistory.set(prompt ?? "", (e8.variable("org-capture--prompt-history") as string[]) ?? []);
      return a;
    });
    strings.push(answer);
    return answer;
  });
  if (properties.length > 0) text = setTemplateProperties(text, properties);
  text = fillPass(text, /%\\([1-9][0-9]*)/g, (m) => {
    const answer = strings[Number(m[1]) - 1];
    return answer ?? e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil");
  });
  // No blank lines first: from the line the text starts on.
  const firstText = text.search(/[^ \t\n]/);
  if (firstText < 0) text = "";
  else {
    const lineStart = text.lastIndexOf("\n", firstText - 1) + 1;
    text = text.slice(lineStart);
    // A newline last, after the rest of the line the text ends on.
    const lastText = text.search(/[^ \t\n][ \t\n]*$/);
    const lineEnd = text.indexOf("\n", lastText);
    text = `${lineEnd < 0 ? text : text.slice(0, lineEnd)}\n`;
  }
  text = untabify(text);
  // The lines %^g put a heading's tags on, their marks taken out.
  text.split("\n").forEach((line, n) => {
    if (line.includes(TAG_LINE)) tagLines.push(n);
  });
  text = text.split(TAG_LINE).join("");
  // %? is where the cursor goes, its first, as org-capture--position-cursor finds it.
  let cursor: number | undefined;
  const q = text.indexOf("%?");
  if (q >= 0) {
    cursor = charCount(text.slice(0, q));
    text = text.slice(0, q) + text.slice(q + 2);
  }
  return { text, cursor, tagLines };
}


/** What a capture under way changed, to finish or undo it. */
let capturing:
  | {
    buffer: string;
    from: string;
    point: e8.Marker;
    level: number;
    modified: boolean;
    /** Whether the capture started a clock, and the clock it stopped, to start again with :clock-resume. */
    clocked?: boolean;
    /** The clock the capture started, at its CLOCK line, as org-capture-clock-was-started. */
    started?: e8.Marker;
    /** The clock it stopped, at its CLOCK line, as :interrupted-clock copies org-clock-marker. */
    interrupted?: { buffer: string; marker: e8.Marker };
    resume?: boolean;
    template: CaptureTemplate;
    /** The template's type: entry, plain, item, checkitem or table-line. */
    type: string;
    wconf: e8.WindowConfiguration;
    /** Where the captured entry ends, as Org's :end-marker. */
    entryEnd: e8.Marker;
    /** Where the captured entry starts, to go to with :jump-to-captured and remember as the last stored. */
    entry: e8.Marker;
    /** What C-c C-k kills, as Org's :begin-marker and :end-marker. */
    killStart: e8.Marker;
    killEnd: e8.Marker;
    /** Whether the target's buffer was visited for the capture, as :new-buffer. */
    newBuffer: boolean;
  }
  | undefined;


/** What org-capture's prefix asks of the target: to capture here (C-0), or to ask a date tree's date (C-1); and the time a date asked for gives. */
interface TargetEnv {
  here?: boolean;
  askDate?: boolean;
  time?: DateTime;
}

/** Runs the functions an option such as :hook names, as org-capture--run-template-functions: one, or a list of them. */
function runTemplateFunctions(t: CaptureTemplate, keyword: string): void {
  const value = option(t, keyword);
  if (value === undefined || value === null || value === false) return;
  if (Array.isArray(value)) {
    for (const f of value) callTargetFunction(f);
    return;
  }
  const name = typeof value === "symbol" ? e8.symbolName(value) : value;
  // Not a function: Org maps over it as a list, which it is not.
  if (typeof value !== "function" && !(typeof name === "string" && e8.fboundp(name))) e8.signal("wrong-type-argument", `Wrong type argument: sequencep, ${String(name)}`);
  callTargetFunction(value);
}

/** Where a capture goes: its buffer and position, as org-capture-set-target-location finds them. */
interface Target {
  buffer: string;
  pos: number;
  /** A position to insert at, as :exact-position. */
  exact?: number;
  /** Whether to insert right there, as :insert-here. */
  insertHere?: boolean;
  /** Whether pos is the heading of an entry to file under, as :target-entry-p. */
  entryP: boolean;
  /** Whether the buffer was visited for the capture, as :new-buffer. */
  newBuffer?: boolean;
}

/**
 * A target's file: the default notes file for an empty name, a name in
 * org-directory, what a function gives, or a variable's value, as
 * org-capture-expand-file.
 */
function expandFile(file: e8.Value | undefined): string {
  const dir = e8.variable("org-directory");
  let location: e8.Value = null;
  if (file === "" || file === undefined) location = e8.variable("org-default-notes-file") ?? null;
  else if (typeof file === "string") location = e8.expandFileName(file, typeof dir === "string" ? e8.expandFileName(dir) : undefined);
  else if (typeof file === "function") location = e8.funcall(file) as e8.Value;
  else if (typeof file === "symbol") {
    const name = e8.symbolName(file);
    location = e8.fboundp(name) ? (e8.funcall(name) as e8.Value) : (e8.variable(name) ?? null);
  }
  if (typeof location !== "string" || !/\S/.test(location)) e8.signal("error", `Invalid file location: ${JSON.stringify(location)}`);
  return location as string;
}

/** Whether the last target buffer had to be visited, as :new-buffer. */
let newTargetBuffer = false;

/** The buffer visiting a target's file, visited if need be, as org-capture-target-buffer. */
function targetBuffer(file: e8.Value | undefined): string {
  const name = expandFile(file);
  const visiting = findBufferVisiting(name);
  if (visiting !== undefined) return visiting;
  newTargetBuffer = true;
  return e8.findFileNoselect(name);
}

/** Calls a function a target names: a function, or its name as a string or symbol. */
function callTargetFunction(f: e8.Value): void {
  if (typeof f === "function") e8.funcall(f);
  else e8.funcall(typeof f === "symbol" ? e8.symbolName(f) : String(f));
}

/** Whether point is on a heading in an Org buffer, as (and (derived-mode-p 'org-mode) (org-at-heading-p)). */
const atOrgHeading = (): boolean => e8.derivedModeP("org-mode") && isHeadingLine(e8.lineText(lineAt()));

/**
 * Finds a template's target, as org-capture-set-target-location: here,
 * a file, an ID, a file's heading, outline path, regexp, date tree or
 * function, a function, or the running clock's entry.
 */
function setTargetLocation(t: CaptureTemplate, prepend: boolean, env: TargetEnv = {}): Target {
  const target = (env.here ? ["here"] : Array.isArray(t[3]) ? t[3] : [t[3]]) as e8.Value[];
  const kind = typeof target[0] === "symbol" ? e8.symbolName(target[0]) : String(target[0]);
  /**
   * The heading an outline path names, as org-find-olp: each title the one
   * heading at its level under the last, a top-level one first, one or,
   * with org-odd-levels-only, two levels down after; signalling when there
   * is none or more than one.
   */
  const olp = (path: string[]): Heading | undefined => {
    let h: Heading | undefined;
    let [lmin, lmax] = [1, 1];
    for (const title of path) {
      const all = headings();
      const [start, end] = h === undefined ? [0, e8.bufferSize()] : subtreeRegion(all, all.findIndex((x) => x.start === h!.start));
      const found = all.filter((x) => x.start >= start && x.start < end && x.level >= lmin && x.level <= lmax && titleWithoutCookies(x.title) === title);
      if (found.length === 0) e8.signal("error", `Heading not found on level ${lmax}: ${title}`);
      if (found.length > 1) e8.signal("error", `Heading not unique on level ${lmax}: ${title}`);
      h = found[0];
      lmin = h.level + 1;
      lmax = lmin + (e8.variable("org-odd-levels-only") === true ? 1 : 0);
    }
    return h;
  };
  newTargetBuffer = false;
  const inBuffer = (buffer: string, find: () => Omit<Target, "buffer">): Target =>
    e8.withCurrentBuffer(buffer, () => e8.saveExcursion(() => e8.saveRestriction(() => (e8.widen(), { buffer, ...find(), newBuffer: newTargetBuffer }))));
  switch (kind) {
    case "here":
      return { buffer: e8.bufferName(e8.currentBuffer()) as string, pos: e8.point(), exact: e8.point(), insertHere: true, entryP: true };
    case "file":
      return inBuffer(targetBuffer(target[1]), () => ({ pos: e8.point(), entryP: false }));
    case "id": {
      const id = typeof target[1] === "symbol" ? e8.symbolName(target[1]) : String(target[1]);
      const found = e8.funcall("org-id-find", id);
      if (!Array.isArray(found) || typeof found[0] !== "string") e8.signal("error", `Cannot find target ID "${id}"`);
      const [file, pos] = found as [string, number];
      return inBuffer(targetBuffer(file), () => ({ pos, entryP: true }));
    }
    case "file+headline":
      return inBuffer(targetBuffer(target[1]), () => {
        const name = String(target[2] ?? "");
        // Its statistics cookies are no part of the name it is found by.
        let h = headings().find((x) => titleWithoutCookies(x.title) === name);
        if (!h) {
          e8.gotoChar(e8.pointMax());
          if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
          e8.insert(`* ${name}\n`);
          h = headings().find((x) => x.title === name) as Heading;
        }
        return { pos: h.start, entryP: true };
      });
    case "file+olp":
      if (target.length < 3) e8.signal("error", `Invalid capture target specification: ${JSON.stringify(t[3])}`);
      return inBuffer(targetBuffer(target[1]), () => {
        const h = olp(target.slice(2).map(String));
        return { pos: h?.start ?? e8.pointMax(), entryP: true };
      });
    case "file+regexp":
      return inBuffer(targetBuffer(target[1]), () => {
        e8.gotoChar(e8.pointMin());
        if (e8.reSearchForward(String(target[2]), { noerror: true }) === undefined) e8.signal("error", `No match for target regexp in file ${String(target[1])}`);
        const at = prepend ? (e8.matchBeginning(0) as number) : (e8.matchEnd(0) as number);
        e8.gotoChar(at);
        return { pos: at, exact: at, entryP: atOrgHeading() };
      });
    case "file+olp+datetree":
      return inBuffer(targetBuffer(target[1]), () => {
        const parent = olp(target.slice(2).map(String));
        const tree = option(t, ":tree-type");
        const treeName = typeof tree === "symbol" ? e8.symbolName(tree) : tree;
        const grouping = treeName === "week" ? "week" : treeName === "month" ? "month" : "day";
        // The day: org-overriding-default-time's, or one asked for with :time-prompt or C-1, else today.
        let day: DateTime = today();
        const over = overridingDefaultTime();
        if (over) day = { year: over.year, month: over.month, day: over.day };
        else if (truthy(option(t, ":time-prompt") ?? null) || env.askDate) {
          const answer = readDateAnswer("Date for tree entry: ");
          // A range's end is read and left out, as org-end-time-was-given is bound there.
          const asked = parseDate(answer, false, undefined, true);
          day = { year: asked.year, month: asked.month, day: asked.day };
          const now = today();
          const isToday = asked.year === now.year && asked.month === now.month && asked.day === now.day;
          // The capture's time: as given, or for another day without one, its start, as :default-time.
          env.time =
            asked.hour !== undefined || isToday
              ? { ...asked, hour: asked.hour ?? today(true).hour, minute: asked.minute ?? today(true).minute }
              : { ...day, hour: Number(e8.variable("org-extend-today-until") ?? 0), minute: 0 };
        }
        // Under the outline path's heading, else a DATE_TREE (or WEEK_TREE) heading or the whole buffer, as Org's capture asks org-datetree.
        const root = dateTreeRoot(grouping, parent?.start);
        return { pos: findDateCreate(day, grouping, root.base, root.start, root.end, root.step), entryP: true };
      });
    case "file+function":
      return inBuffer(targetBuffer(target[1]), () => {
        callTargetFunction(target[2]);
        return { pos: e8.point(), exact: e8.point(), entryP: atOrgHeading() };
      });
    case "function": {
      // In the buffer it leaves current, where it leaves point.
      const [buffer, pos, entryP] = e8.saveExcursion(() => {
        callTargetFunction(target[1]);
        return [e8.bufferName(e8.currentBuffer()) as string, e8.point(), atOrgHeading()] as const;
      });
      return { buffer, pos, exact: pos, entryP };
    }
    case "clock": {
      const running = runningEntry();
      if (!running) e8.userError("No running clock that could be used as capture target");
      return { buffer: running!.buffer, pos: running!.start, entryP: true };
    }
    default:
      return e8.signal("error", `Invalid capture target specification: ${JSON.stringify(t[3])}`) as never;
  }
}

/** Where the entry at point ends: its next heading, or the end, as org-entry-end-position. */
function entryEndPosition(): number {
  const next = headings().find((h) => h.start > e8.point());
  return next ? next.start : e8.pointMax();
}

/** The blank lines before point go, and N come instead, as org-capture-empty-lines-before. */
function emptyLinesBefore(n: number): void {
  const here = e8.point();
  let back = here;
  while (back > e8.pointMin() && /[ \t\n\r]/.test(e8.bufferText(back - 1, back))) back--;
  if (back < here) back = e8.lineEnd(lineAt(back)) < here ? e8.lineEnd(lineAt(back)) + 1 : here;
  if (back < here) e8.deleteRegion(back, here);
  e8.gotoChar(back);
  e8.insert("\n".repeat(n));
}

/** The blank lines after point go, and N come, point staying, as org-capture-empty-lines-after does after a line. */
function emptyLinesAfter(n: number): void {
  while (e8.point() < e8.pointMax() && /^[ \t]*$/.test(e8.lineText(lineAt())) && e8.lineEnd(lineAt()) < e8.pointMax()) {
    e8.deleteRegion(e8.point(), e8.lineEnd(lineAt()) + 1);
  }
  e8.saveExcursion(() => e8.insert("\n".repeat(n)));
}

/** A filled template: its text, where %? put the cursor, and the lines %^g gave tags. */
type Filled = ReturnType<typeof fillTemplate>;

/** What a placed capture spans and where the cursor goes. */
interface Placed {
  beg: number;
  end: number;
  level: number;
  cursor: number;
  /** What C-c C-k kills: from where the capture began inserting, as Org's :begin-marker, to its :end-marker. */
  killStart: e8.Marker;
  killEnd: number;
}

/** Narrows to the capture unless :unnarrowed, as org-capture-narrow. */
function captureNarrow(t: CaptureTemplate, beg: number, end: number): void {
  if (!truthy(option(t, ":unnarrowed") ?? null)) e8.narrowToRegion(beg, end);
}

/** Places the template as a new entry, as org-capture-place-entry. */
function placeEntry(t: CaptureTemplate, where: Target, filled: Filled, prepend: boolean): Placed {
  if (where.exact !== undefined) e8.gotoChar(where.exact);
  let level = 1;
  const all = headings();
  const i = headingIndex(all, lineAt());
  const atHeading = i !== undefined && all[i].line === lineAt();
  if (where.insertHere) level = validLevel(i !== undefined ? all[i].level : 1, 0);
  else if (where.entryP) {
    // A level below, odd with org-odd-levels-only, as org-get-valid-level gives it.
    level = validLevel(atHeading ? all[i!].level : 1, 1);
    // First, before its first child, as outline-next-heading; else after its subtree.
    e8.gotoChar(prepend ? (all[(i ?? -1) + 1]?.start ?? e8.pointMax()) : i === undefined ? e8.pointMax() : subtreeRegion(all, i)[1]);
  } else if (prepend) {
    e8.gotoChar(e8.pointMin());
    if (!atOrgHeading()) e8.gotoChar(all.find((h) => h.start > e8.point())?.start ?? e8.pointMax());
  } else e8.gotoChar(e8.pointMax());
  const origin = e8.makeMarker(e8.point());
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  emptyLinesBefore(emptyLines(t, ":empty-lines-before"));
  // The template as a subtree at the target's level, as org-paste-subtree
  // puts it: inserted as it is, %? still in it, then shifted a level at a
  // time, each heading demoted or promoted with its hooks.
  const text = filled.cursor === undefined ? filled.text : [...filled.text].slice(0, filled.cursor).join("") + "%?" + [...filled.text].slice(filled.cursor).join("");
  if (!killIsSubtree(text)) e8.signal("error", "Template is not a valid Org entry or tree");
  const first = /^(\*+) /m.exec(text)?.[1].length ?? level;
  const shift = level - first;
  const beg = e8.point();
  e8.insert(text);
  // Advancing, so lines a hook adds after the last heading are the entry's.
  const endMark = e8.makeMarker(e8.point(), { advances: true });
  if (shift !== 0) shiftHeadings(beg, e8.point(), shift);
  // Tags aligned where %^g put them, as Org aligns them as it fills the template.
  for (let l = lineAt(beg); l < lineAt(e8.markerPosition(endMark)!); l++) {
    const h = parseHeading(l);
    if (h && h.tagsAt !== undefined && filled.tagLines.includes(l - lineAt(beg))) alignTags(l);
  }
  // The cursor where %? is, taken out, as org-capture--position-cursor finds it.
  let cursor: number | undefined;
  const found = e8.bufferText(beg, e8.markerPosition(endMark)!).indexOf("%?");
  if (found >= 0) {
    const at = beg + [...e8.bufferText(beg, e8.markerPosition(endMark)!).slice(0, found)].length;
    e8.deleteRegion(at, at + 2);
    cursor = at - beg;
  }
  e8.gotoChar(e8.markerPosition(endMark)!);
  e8.deleteMarker(endMark);
  e8.message(`Clipboard pasted as level ${level} subtree`);
  // Blank lines after it go too, and the template's come, as org-capture-empty-lines-after.
  {
    const after = e8.point();
    let q = after;
    while (q < e8.pointMax() && /^[ \t]*$/.test(e8.lineText(lineAt(q))) && e8.lineEnd(lineAt(q)) < e8.pointMax()) q = e8.lineEnd(lineAt(q)) + 1;
    if (q > after) e8.deleteRegion(after, q);
    e8.saveExcursion(() => e8.insert("\n".repeat(emptyLines(t, ":empty-lines-after"))));
  }
  const endPos = e8.point();
  // Org kills to the next heading, the blank lines after it too.
  const killEnd = headings().find((h) => h.start >= endPos)?.start ?? e8.pointMax();
  // With its last newline at the end of the buffer, else without, as org-capture-narrow is given.
  captureNarrow(t, beg, endPos === e8.bufferSize() ? endPos : endPos - 1);
  e8.gotoChar(cursor === undefined ? beg : beg + cursor);
  return { beg, end: endPos, level, cursor: e8.point(), killStart: origin, killEnd };
}

/** Places the template as plain text, as org-capture-place-plain-text: into the entry's text, or at the file's start or end. */
function placePlain(t: CaptureTemplate, where: Target, filled: Filled, prepend: boolean): Placed {
  if (where.exact !== undefined) e8.gotoChar(where.exact);
  else if (where.entryP) {
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (prepend && i !== undefined) e8.gotoChar(endOfMetaData(all[i], true));
    else e8.gotoChar(all.find((h) => h.start > e8.point())?.start ?? e8.pointMax());
  } else e8.gotoChar(prepend ? e8.pointMin() : e8.pointMax());
  const origin = e8.makeMarker(e8.point());
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  emptyLinesBefore(emptyLines(t, ":empty-lines-before"));
  const beg = e8.point();
  e8.insert(filled.text);
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  const end = Math.max(beg, e8.point() - 1);
  {
    const after = e8.point();
    let q = after;
    while (q < e8.pointMax() && /^[ \t]*$/.test(e8.lineText(lineAt(q))) && e8.lineEnd(lineAt(q)) < e8.pointMax()) q = e8.lineEnd(lineAt(q)) + 1;
    if (q > after) e8.deleteRegion(after, q);
    e8.saveExcursion(() => e8.insert("\n".repeat(emptyLines(t, ":empty-lines-after"))));
  }
  const endPos = e8.point();
  captureNarrow(t, beg, end);
  e8.gotoChar(filled.cursor === undefined ? beg : beg + filled.cursor);
  return { beg, end: endPos, level: 0, cursor: e8.point(), killStart: origin, killEnd: endPos };
}

/** Text with its common indentation taken away, as org-remove-indentation. */
function removeIndentation(text: string): string {
  const lines = text.split("\n");
  const widths = lines.filter((l) => /\S/.test(l)).map((l) => /^[ \t]*/.exec(l)![0].replace(/\t/g, "        ").length);
  const n = widths.length === 0 ? 0 : Math.min(...widths);
  if (n === 0) return text;
  return lines
    .map((l) => {
      let col = 0;
      let i = 0;
      while (i < l.length && col < n && (l[i] === " " || l[i] === "\t")) {
        col = l[i] === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
        i++;
      }
      return " ".repeat(Math.max(0, col - n)) + l.slice(i);
    })
    .join("\n");
}

/** A filled template with %? taken out, its place kept in the text as a marker character for placing. */
const CURSOR = "\u0000";

/** The filled text with the cursor's place marked, to transform with the text. */
const withCursor = (filled: Filled): string =>
  filled.cursor === undefined ? filled.text : [...filled.text].slice(0, filled.cursor).join("") + CURSOR + [...filled.text].slice(filled.cursor).join("");

/** Takes the cursor's mark out of what was inserted between BEG and END, and returns where it was. */
function takeCursor(beg: number, end: number): number | undefined {
  const text = e8.bufferText(beg, end);
  const at = text.indexOf(CURSOR);
  if (at < 0) return undefined;
  const pos = beg + charCount(text.slice(0, at));
  e8.deleteRegion(pos, pos + 1);
  return pos;
}

/** Places the template as a plain list item, as org-capture-place-item: in the first list there, else a new one. */
function placeItem(t: CaptureTemplate, where: Target, filled: Filled, prepend: boolean): Placed {
  let template = removeIndentation(withCursor(filled));
  // With a bullet, a dash and the lines under it if it has none.
  // As org-item-re: a star only indented, so "* x" is no item.
  if (!ITEM_RE.test(template)) template = `- ${template.split("\n").join("\n  ")}`;
  let beg: number;
  let end: number;
  if (where.exact !== undefined) {
    e8.gotoChar(where.exact);
    beg = e8.lineStart(lineAt());
    end = where.insertHere ? beg : entryEndPosition();
  } else if (where.entryP) {
    beg = lineStartOrEnd(lineAt() + 1);
    end = entryEndPosition();
  } else [beg, end] = [e8.pointMin(), e8.pointMax()];
  // The first plain list there.
  let list: Elem | undefined;
  for (let l = lineAt(beg); l < e8.lineCount() && e8.lineStart(l) < end; l++) {
    if (!ITEM_RE.test(e8.lineText(l))) continue;
    for (let e = elementAt(e8.lineStart(l)); e; e = e.parent) {
      if (e.type === "plain-list") {
        list = e;
        break;
      }
    }
    if (list) break;
  }
  if (list) e8.gotoChar(prepend ? list.begin : lineStartOrEnd(lineAt(endBeforeBlank(list)) + 1));
  else if (where.insertHere) e8.gotoChar(beg);
  else if (!prepend) e8.gotoChar(end);
  else {
    const all = headings();
    const i = headingIndex(all, lineAt());
    e8.gotoChar(i === undefined ? beg : Math.max(endOfMetaData(all[i]), beg));
  }
  const origin = e8.makeMarker(e8.point());
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  // In a list, at most one blank line between items, and none before a prepended one.
  const between = Math.min(1, emptyLines(t, ":empty-lines-before"));
  if (!(list && prepend)) emptyLinesBefore(list ? between : emptyLines(t, ":empty-lines-before"));
  const start = e8.lineStart(lineAt());
  const body = template.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  e8.insert(`${body}\n`);
  const endMarker = e8.makeMarker(e8.point());
  let cursor: number | undefined;
  try {
    if (list) {
      // Ordered by a number, or a letter with org-list-allow-alphabetical, as the plain list's type says.
      const ordered = (alphabetical() ? /^[ \t]*(?:\d+|[A-Za-z])[.)]/ : /^[ \t]*\d+[.)]/).test(e8.lineText(lineAt(list.begin === start ? (e8.markerPosition(endMarker) as number) : list.begin)));
      // The list's indentation; a prepended item takes the list's, where Org's takes its own.
      const indent = /^[ \t]*/.exec(e8.lineText(lineAt(list.begin === start ? (e8.markerPosition(endMarker) as number) : list.begin)))![0].length;
      e8.saveExcursion(() => {
        e8.gotoChar(start);
        while (e8.point() < (e8.markerPosition(endMarker) as number)) {
          if (indent > 0) e8.insert(" ".repeat(indent));
          if (forwardLine(1) !== 0) break;
        }
        e8.gotoChar(start);
        // A prepended item of the other type takes the list's, as Org cycles its bullet.
        if (prepend && ordered !== /^[A-Za-z0-9][.)]/.test(body)) cycleListBullet(ordered ? "1." : "-");
        e8.call("org-list-repair");
      });
    }
    if (!(list && !prepend)) emptyLinesAfter(list ? Math.min(1, emptyLines(t, ":empty-lines-after")) : emptyLines(t, ":empty-lines-after"));
  } finally {
    cursor = takeCursor(start, e8.markerPosition(endMarker) as number);
  }
  const stop = e8.markerPosition(endMarker) as number;
  e8.deleteMarker(endMarker);
  captureNarrow(t, start, stop - 1);
  e8.gotoChar(cursor ?? start);
  return { beg: start, end: stop, level: 0, cursor: e8.point(), killStart: origin, killEnd: stop };
}

/** Places the template as a table line, as org-capture-place-table-line: in the first table there, else a new one. */
function placeTableLine(t: CaptureTemplate, where: Target, filled: Filled, prepend: boolean): Placed {
  const trimmed = withCursor(filled).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  // A line not starting with a bar, as org-table-border-regexp finds, is a bad template.
  const text = /^[ \t]*[^| \t\n]/m.test(trimmed) ? `| ${CURSOR}Bad template |\n` : `${trimmed}\n`;
  let beg: number;
  let end: number;
  if (where.exact !== undefined) {
    e8.gotoChar(where.exact);
    beg = e8.lineStart(lineAt());
    end = where.insertHere ? beg : entryEndPosition();
  } else if (!where.entryP) [beg, end] = [e8.pointMin(), e8.pointMax()];
  else {
    beg = lineStartOrEnd(lineAt() + 1);
    end = entryEndPosition();
  }
  let table: Elem | undefined;
  for (let l = lineAt(beg); l < e8.lineCount() && e8.lineStart(l) < end && !table; l++) {
    if (!/^[ \t]*\|[^-]/.test(e8.lineText(l))) continue;
    for (let e = elementAt(e8.lineStart(l)); e; e = e.parent) {
      // An Org table, not a table.el one, which Org passes over.
      if (e.type === "table") {
        if (e.tableType !== "table.el") table = e;
        break;
      }
    }
  }
  let tableStart: number;
  let tableEnd: number;
  if (table) {
    tableStart = table.begin;
    // After its rows, before any #+TBLFM: lines, as org-table-end takes it.
    tableEnd = table.contentsEnd ?? lineStartOrEnd(lineAt(endBeforeBlank(table)) + 1);
  } else {
    // None: a new one, with an empty header.
    e8.gotoChar(end);
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    tableStart = e8.point();
    e8.insert("|   |\n|---|\n");
    tableEnd = e8.point();
  }
  const rows = (): number[] => {
    const out: number[] = [];
    for (let l = lineAt(tableStart); e8.lineStart(l) < tableEnd && l < e8.lineCount(); l++) out.push(l);
    return out;
  };
  const pos = option(t, ":table-line-pos");
  const spec = typeof pos === "string" ? /(I+)([-+][0-9]+)/.exec(pos) : null;
  // Here, after the new table's header, as Org leaves point there.
  if (where.insertHere) {
    // Nowhere else to go.
  }
  else if (spec) {
    // After the line delta lines from the Nth rule, as org-table-hlines numbers them.
    const lines = rows();
    const hlines = lines.filter((l) => /^[ \t]*\|-/.test(e8.lineText(l)));
    const hline = hlines[spec[1].length - 1];
    if (hline === undefined) e8.signal("error", `Invalid table line specification ${JSON.stringify(pos)}`);
    const delta = Number(spec[2]);
    const line = hline - lineAt(tableStart);
    // forward-line stops at the table's first line, then one more down.
    const target = lineAt(tableStart) + Math.max(0, line + delta + (delta < 0 ? 0 : -1)) + 1;
    e8.gotoChar(target >= lineAt(tableEnd) ? tableEnd : e8.lineStart(target));
  } else if (prepend) {
    // Before the first data line after the first rule.
    const lines = rows();
    const rule = lines.findIndex((l) => /^[ \t]*\|-/.test(e8.lineText(l)));
    if (rule < 0) e8.gotoChar(tableStart);
    else {
      const data = lines.slice(rule + 1).find((l) => /^[ \t]*\|[^-]/.test(e8.lineText(l)));
      e8.gotoChar(data !== undefined ? e8.lineStart(data) : tableEnd);
    }
  } else e8.gotoChar(tableEnd);
  const origin = e8.makeMarker(e8.point());
  const sizeBefore = e8.bufferSize();
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  const start = e8.point();
  e8.insert(text);
  let stop = e8.point();
  const cursor = takeCursor(start, stop);
  if (cursor !== undefined) stop--;
  // Narrowed to the table, grown by the new line, as Org narrows before
  // inserting, whether or not :unnarrowed, then to the line unless it.
  e8.narrowToRegion(tableStart, tableEnd + e8.bufferSize() - sizeBefore);
  captureNarrow(t, start, stop - 1);
  e8.gotoChar(cursor ?? start);
  return { beg: start, end: stop, level: 0, cursor: e8.point(), killStart: origin, killEnd: stop };
}

/**
 * A template's text, as org-capture-set-plist and org-capture-get-template
 * give it: the type's default for an empty one, a file's contents for
 * ["file", NAME], what a function gives for ["function", F].
 */
function captureTemplateText(value: e8.Value | undefined, type: string): string {
  const isEmpty = value === undefined || value === null || (typeof value === "string" && !/\S/.test(value));
  if (isEmpty) return ({ item: "- %?", checkitem: "- [ ] %?", "table-line": "| %? |", entry: "* %?\n  %a" } as Record<string, string>)[type] ?? "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const kind = typeof value[0] === "symbol" ? e8.symbolName(value[0]) : value[0];
    if (kind === "file") {
      const dir = e8.variable("org-directory");
      const name = e8.expandFileName(String(value[1]), typeof dir === "string" ? e8.expandFileName(dir) : undefined);
      if (!e8.fileExists(name)) return `* Template file ${String(value[1])} not found`;
      const temp = e8.bufferName(e8.getBufferCreate(e8.generateNewBufferName(" *org capture template*"))) as string;
      try {
        return e8.withCurrentBuffer(temp, () => (e8.insertFileContents(name), e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())));
      } finally {
        e8.call("kill-buffer", temp);
      }
    }
    if (kind === "function") {
      const f = value[1];
      const name = typeof f === "symbol" ? e8.symbolName(f) : f;
      if (typeof f === "function" || (typeof name === "string" && e8.fboundp(name))) return String(e8.funcall(typeof f === "function" ? f : (name as string)) ?? "");
      return `* Template function ${String(name)} not found`;
    }
  }
  return "";
}

/**
 * Puts the entry a template makes into its target and shows it there,
 * narrowed, as org-capture-place-entry and org-capture-place-template do.
 */
function captureWith(key: string, goto: e8.Value = null): void {
  const t = captureTemplates().find((x) => x[0] === key);
  if (!t) throw new Error(`No capture template referred to by "${key}" keys`);
  const [, , rawType, target] = t;
  // An empty template is Org's default for the type, as org-capture-set-plist gives it.
  const type = rawType === undefined || rawType === null || rawType === "" ? "entry" : String(typeof rawType === "symbol" ? e8.symbolName(rawType) : rawType);
  if (!["entry", "plain", "item", "checkitem", "table-line"].includes(type)) e8.signal("error", `Invalid capture type: ${type}`);
  const template = captureTemplateText(t[4], type);
  if (capturing) throw new Error("A capture is already under way: C-c C-c or C-c C-k finishes it");
  const from = e8.windowBuffer() ?? "";
  // The windows as they are, to put back when the capture ends, as :return-to-wconf.
  const wconf = e8.currentWindowConfiguration();
  // A marker, as the buffer the capture came from stays editable below it.
  const point = e8.makeMarker(e8.point());
  const mark = e8.mark();
  const initial = e8.regionActive() && mark !== undefined && mark !== e8.point()
    ? e8.bufferSubstringNoProperties(Math.min(mark, e8.point()), Math.max(mark, e8.point()))
    : "";
  const link = annotation();
  // A Dired buffer's directory, as :original-file is for one.
  const originalFile = e8.bufferFileName() ?? (e8.derivedModeP("dired-mode") ? String(e8.variable("default-directory") ?? "") : undefined);
  const running = runningEntry();
  const clockContext = running
    ? e8.withCurrentBuffer(running.buffer, () => {
        const h = headings().find((x) => x.start === running.start);
        const path = e8.bufferFileName();
        // %k is org-clock-heading; %K's link names the heading, its links as their descriptions.
        const heading = (h?.title ?? "").replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_m, l: string, d?: string) => d ?? l);
        const title = String(e8.variable("org-clock-heading") ?? heading);
        return { title, link: path === undefined ? "" : `[[file:${e8.abbreviateFileName(path)}::*${heading}][${heading}]]` };
      })
    : undefined;
  const prepend = truthy(option(t, ":prepend") ?? null);
  // The capture's time: org-overriding-default-time, as :default-time takes it, else now.
  const env: TargetEnv = { here: goto === 0, askDate: goto === 1, time: overridingDefaultTime() };
  const where = setTargetLocation(t, prepend, env);
  const buffer = where.buffer;
  const modified = e8.withCurrentBuffer(buffer, () => e8.bufferModified());
  // %^g's tags: the target file's, as org-global-tags-completion-table gives them for it; none without a file.
  const targetFile = e8.withCurrentBuffer(buffer, () => e8.bufferFileName());
  const tags = (targetFile === undefined ? globalTagsCompletionTable() : globalTagsCompletionTable([targetFile])).map(([tag]) => tag);
  // An error filling it is said as Org says it.
  const filled = e8.conditionCase(
    () => fillTemplate(template, { annotation: link, initial, tags, file: originalFile, clock: clockContext, time: env.time, target: where }),
    { error: (err) => e8.signal("error", `Capture abort: ${e8.errorMessageString(err)}`) as never },
  );
  // The buffer's point kept, as Org places the template in an indirect buffer.
  const pointBefore = e8.withCurrentBuffer(buffer, () => e8.point());
  const placed = e8.conditionCase(
    () =>
      e8.withCurrentBuffer(buffer, () => {
        e8.widen();
        e8.gotoChar(where.pos);
        const r =
          type === "entry"
            ? placeEntry(t, where, filled, prepend)
            : type === "plain"
              ? placePlain(t, where, filled, prepend)
              : type === "table-line"
                ? placeTableLine(t, where, filled, prepend)
                : placeItem(t, where, filled, prepend);
        runTemplateFunctions(t, ":hook");
        e8.callWithPrefix(1, "org-capture-mode");
        // Where the hook left point.
        return { ...r, cursor: e8.point() };
      }),
    {
      // Said with the template's key, as org-capture does.
      error: (err) => {
        e8.setWindowConfiguration(wconf);
        // Not narrowed to the capture, as Org's indirect buffer goes.
        e8.withCurrentBuffer(buffer, () => {
          e8.widen();
          if (truthy(e8.variable("org-capture-mode") ?? null)) e8.callWithPrefix(-1, "org-capture-mode");
          e8.gotoChar(Math.min(pointBefore, e8.pointMax()));
        });
        // The window showing it there too.
        const window = getBufferWindow(buffer);
        if (window) e8.setWindowPoint(window, Math.min(pointBefore, e8.withCurrentBuffer(buffer, () => e8.pointMax())));
        return e8.signal("error", `Capture template \u2018${key}\u2019: ${e8.errorMessageString(err)}`);
      },
    },
  );
  capturing = {
    buffer,
    from,
    point,
    level: placed.level,
    modified,
    template: t,
    type,
    wconf,
    entry: e8.withCurrentBuffer(buffer, () => e8.makeMarker(placed.beg)),
    entryEnd: e8.withCurrentBuffer(buffer, () => e8.makeMarker(placed.end, { advances: true })),
    killStart: placed.killStart,
    killEnd: e8.withCurrentBuffer(buffer, () => e8.makeMarker(placed.killEnd, { advances: true })),
    newBuffer: where.newBuffer === true,
  };
  // :clock-in starts a clock on the entry, stopping one running, as org-capture does.
  const clockOption = option(t, ":clock-in");
  // The cursor kept by a marker, as clocking out above it adds text.
  const cursorMarker = e8.withCurrentBuffer(buffer, () => e8.makeMarker(placed.cursor));
  if (clockOption !== undefined && clockOption !== null && clockOption !== false) {
    const running = runningClockLine();
    if (running) capturing.interrupted = { buffer: running.buffer, marker: e8.withCurrentBuffer(running.buffer, () => e8.makeMarker(running.pos)) };
    const resume = option(t, ":clock-resume");
    capturing.resume = resume !== undefined && resume !== null && resume !== false;
    // On the heading the capture is in, widened, as plain text's is its target's.
    e8.withCurrentBuffer(buffer, () => {
      e8.saveExcursion(() =>
        e8.saveRestriction(() => {
          e8.widen();
          e8.gotoChar(placed.beg);
          clockIn();
          const line = runningClockLine();
          if (line) capturing!.started = e8.withCurrentBuffer(line.buffer, () => e8.makeMarker(line.pos));
          // The clock's drawer stays shown, as Org folds it in the indirect buffer it captures in, not the file's;
          // the entry found by its marker, as clocking the other entry out may have added text above it.
          const at = e8.markerPosition(capturing!.entry) ?? placed.beg;
          const h = headings().filter((x) => x.start <= at).at(-1);
          if (h) flag(h.start, e8.markerPosition(capturing!.entryEnd) ?? e8.pointMax(), false, "org-hide-drawer");
        }),
      );
    });
    capturing.clocked = true;
  }
  // The capture above, the buffer it came from below, as org-capture's windows are.
  e8.call("delete-other-windows");
  e8.splitWindow(undefined, "below");
  e8.setWindowBuffer(undefined, buffer);
  e8.gotoChar(e8.markerPosition(cursorMarker) ?? placed.cursor);
  e8.deleteMarker(cursorMarker);
  // Finished at once, as org-capture does with :immediate-finish.
  if (truthy(option(t, ":immediate-finish") ?? null)) finalize(false);
}

/** Back to the windows and point from before the capture. */
function endCapture(): void {
  const state = capturing;
  if (!state) throw new Error("This does not seem to be a capture buffer for Org mode");
  capturing = undefined;
  e8.withCurrentBuffer(state.buffer, () => {
    e8.widen();
    e8.callWithPrefix(-1, "org-capture-mode");
  });
  // The windows as they were, as org-capture-finalize sets :return-to-wconf back.
  e8.setWindowConfiguration(state.wconf);
  if (e8.bufferLiveP(e8.getBuffer(state.from))) e8.withCurrentBuffer(state.from, () => e8.gotoChar(e8.markerPosition(state.point) ?? e8.point()));
  e8.deleteMarker(state.point);
}

e8.defineCommand({
  name: "org--capture-with",
  doc: "Capture with the template of the key given, as org-capture does once it has asked.",
  params: [{ name: "key", kind: "string", prompt: "Template key: " }],
  run: (key) => captureWith(key),
});

e8.defineCommand({
  name: "org-capture",
  doc:
    "Capture a note, asking for one of org-capture-templates by its key in *Org Select*: its entry goes into its " +
    "target file, shown narrowed to it. C-c C-c files it and C-c C-k takes it away.",
  // Code names a template with org--capture-with, as Lisp passes org-capture KEYS.
  params: [{ name: "goto", kind: "prefix" }],
  run: (goto: e8.PrefixArg) => {
    const keys = "";
    // From the agenda, the date at point, as org-capture-use-agenda-date says: set, as Org's setq leaves it.
    if (truthy(e8.variable("org-capture-use-agenda-date") ?? null) && e8.derivedModeP("org-agenda-mode")) {
      e8.setVariable("org-overriding-default-time", e8.funcall("org-get-cursor-date", goto === 1) as number);
    }
    // With C-u, to the template's target; with C-u C-u, to where the last capture went.
    if (Array.isArray(goto) && goto[0] === 4) return gotoTarget(keys || undefined);
    if (Array.isArray(goto) && goto[0] === 16) return goLastStored();
    const chosen = selectTemplate(keys || undefined);
    if (chosen === "q") e8.userError("Abort");
    if (chosen === "C") {
      e8.call("describe-variable", "org-capture-templates");
      return;
    }
    // C-0 captures here, C-1 asks a date tree's date.
    captureWith(String((chosen as e8.Value[])[0]), goto);
  },
});

/** The template KEYS names, or one chosen in *Org Select*, or "C" or "q", as org-capture-select-template. */
function selectTemplate(keys?: string): e8.Value[] | string {
  if (keys !== undefined) {
    const t = captureTemplates().find((x) => x[0] === keys);
    if (!t) e8.userError(`No capture template referred to by "${keys}" keys`);
    return t as unknown as e8.Value[];
  }
  // Org's one default template when there are none.
  return orgMks(captureTemplates() as unknown as e8.Value[][], "Select a capture template\n=========================", "Template key: ", [
    ["C", "Customize org-capture-templates"],
    ["q", "Abort"],
  ]) as e8.Value[] | string;
}

/** Goes to a template's target, capturing nothing, as org-capture-goto-target. */
function gotoTarget(keys?: string): void {
  const chosen = selectTemplate(keys);
  if (typeof chosen === "string") e8.signal("error", "No capture template selected");
  const t = chosen as unknown as CaptureTemplate;
  const where = setTargetLocation(t, truthy(option(t, ":prepend") ?? null));
  e8.call("pop-to-buffer-same-window", where.buffer);
  // Widened, as org-capture-set-target-location leaves it.
  e8.widen();
  e8.gotoChar(where.pos);
}

e8.defineCommand({
  name: "org-capture-goto-target",
  doc: "Go to where a capture template files its notes, asking for the template, capturing nothing.",
  params: [{ name: "template-key", value: () => "" }],
  run: (key: string) => gotoTarget(key || undefined),
});

/**
 * While the clock the capture started still runs, stops it, unless
 * :clock-keep, and starts the one it stopped again with :clock-resume, as
 * org-capture-finalize does, finishing or aborting.
 */
function finishClock(state: NonNullable<typeof capturing>): void {
  const started = state.started;
  const now = runningClockLine();
  const same = started !== undefined && now !== undefined && e8.markerBuffer(started) === now.buffer && e8.markerPosition(started) === now.pos;
  // Kept, its name read again from the heading now written, as org-clock-update-mode-line with REFRESH.
  if (state.clocked && same && truthy(option(state.template, ":clock-keep") ?? null)) refreshClockHeading();
  if (state.clocked && same && !truthy(option(state.template, ":clock-keep") ?? null)) {
    e8.letBind({ "org-log-note-clock-out": null }, () => clockOut(true));
    const interrupted = state.interrupted;
    if (interrupted && state.resume && e8.bufferLiveP(e8.getBuffer(interrupted.buffer))) {
      e8.withCurrentBuffer(interrupted.buffer, () => {
        e8.saveExcursion(() =>
          e8.saveRestriction(() => {
            e8.widen();
            e8.gotoChar(e8.markerPosition(interrupted.marker) ?? 0);
            clockIn();
          }),
        );
      });
      e8.message("Interrupted clock has been resumed");
    }
  }
  if (state.interrupted) e8.deleteMarker(state.interrupted.marker);
  if (started) e8.deleteMarker(started);
  state.interrupted = undefined;
  state.started = undefined;
}

/**
 * Finishes the capture, as org-capture-finalize: the template's and the
 * hooks' functions run, the capture's clock stops unless :clock-keep, the
 * cookies are counted, its place remembered, the file saved, a buffer
 * visited for it killed with :kill-buffer, and the windows put back; to
 * the entry with :jump-to-captured or STAY.
 */
function finalize(stay: boolean, refiling = false): void {
  {
    const buffer = capturing?.buffer;
    const state = capturing;
    if (state) {
      e8.withCurrentBuffer(state.buffer, () => {
        runTemplateFunctions(state.template, ":prepare-finalize");
        e8.runHooks("org-capture-prepare-finalize-hook");
      });
    }
    if (state) finishClock(state);
    // The statistics cookies count the new entry, as org-capture-finalize
    // brings them up to date from the heading the entry is, or is in.
    if (state) {
      e8.withCurrentBuffer(state.buffer, () =>
        e8.saveExcursion(() =>
          e8.saveRestriction(() => {
            e8.widen();
            const pos = e8.markerPosition(state.entry) ?? e8.point();
            const h = headings().filter((x) => x.start <= pos).at(-1);
            if (h) {
              e8.gotoChar(h.start);
              updateParentTodoStatistics(h.line);
              updateCheckboxCount();
            }
          }),
        ),
      );
    }
    // A table line's table, if point is still in it, aligned, or with
    // formulas, its formulas fixed for the rows added and recalculated, as
    // org-capture-finalize does.
    if (state?.type === "table-line") {
      e8.withCurrentBuffer(state.buffer, () =>
        e8.saveRestriction(() => {
          e8.widen();
          if (!atTable()) return;
          if (getStoredFormulas().length === 0) {
            e8.call("org-table-align");
            return;
          }
          if (truthy(option(state.template, ":immediate-finish") ?? null) || fixFormulasConfirmed()) {
            const added = e8.bufferText(e8.markerPosition(state.killStart) ?? 0, e8.markerPosition(state.killEnd) ?? 0);
            const lines = (added.match(/\n/g) ?? []).length + (added !== "" && !added.endsWith("\n") ? 1 : 0);
            fixFormulas("@", [], currentDline() - 1, lines);
          }
          recalculate(true);
        }),
      );
    }
    // Where it went, as org-capture-last-stored-marker and the bookmark, as
    // org-capture-store-last-position, widened so the bookmark keeps the text around it.
    if (state) {
      e8.withCurrentBuffer(state.buffer, () =>
        e8.saveExcursion(() =>
          e8.saveRestriction(() => {
            e8.widen();
            e8.gotoChar(e8.markerPosition(state.entry) ?? e8.point());
            if (lastStored) e8.deleteMarker(lastStored);
            lastStored = e8.makeMarker(e8.point());
            const name = lastStoredBookmark();
            if (name === undefined) return;
            try {
              bookmarkSet(name);
            } catch (err) {
              e8.message(`Bookmark set error: (error ${JSON.stringify(err instanceof Error ? err.message : String(err))})`);
            }
          }),
        ),
      );
      // Widened, as Org runs it.
      e8.withCurrentBuffer(state.buffer, () =>
        e8.saveRestriction(() => {
          e8.widen();
          runTemplateFunctions(state.template, ":before-finalize");
          e8.runHooks("org-capture-before-finalize-hook");
        }),
      );
    }
    endCapture();
    if (buffer !== undefined && !(state && truthy(option(state.template, ":no-save") ?? null))) {
      e8.withCurrentBuffer(buffer, () => {
        if (e8.bufferFileName()) e8.call("save-buffer");
      });
    }
    // A buffer visited for the capture goes with :kill-buffer, saved first, unless refiling, which kills it after.
    if (state && state.newBuffer && !refiling && truthy(option(state.template, ":kill-buffer") ?? null) && e8.bufferLiveP(e8.getBuffer(state.buffer))) {
      e8.withCurrentBuffer(state.buffer, () => {
        if (e8.bufferFileName()) e8.call("save-buffer");
      });
      e8.call("kill-buffer", state.buffer);
    }
    if (state) runTemplateFunctions(state.template, ":after-finalize");
    e8.runHooks("org-capture-after-finalize-hook");
    // To the entry, as org-capture-goto-last-stored, with :jump-to-captured or C-u.
    if (state && !refiling && (truthy(option(state.template, ":jump-to-captured") ?? null) || stay)) goLastStored();
    if (state) {
      e8.deleteMarker(state.entry);
      e8.deleteMarker(state.entryEnd);
      e8.deleteMarker(state.killStart);
      e8.deleteMarker(state.killEnd);
    }
  }
}

const captureFinalize = e8.defineCommand({
  name: "org-capture-finalize",
  doc: "Finish the capture: the entry stays in its file, which is saved, and the windows go back to how they were. With C-u, go to the entry.",
  params: [{ name: "stay", kind: "prefix" }],
  run: (stay: e8.Value) => finalize(stay !== null && stay !== undefined),
});

e8.defineVariable({ name: "org-capture-is-refiling", doc: "Non-nil while the capture's entry is being refiled from it.", value: null });

const captureRefile = e8.defineCommand({
  name: "org-capture-refile",
  doc: "Finish the capture and refile its entry, as org-refile does, with the prefix argument given to it; :refile-targets stands for org-refile-targets.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.Value) => {
    const state = capturing;
    if (!state) throw new Error("This does not seem to be a capture buffer for Org mode");
    if (state.type !== "entry") e8.userError("Refiling from a capture buffer makes only sense for \u2018entry\u2019-type templates");
    // The entry's heading, marked in its buffer, as finishing may change the text around it.
    const base = state.buffer;
    const pos = e8.withCurrentBuffer(base, () => {
      const all = headings();
      const i = headingIndex(all, lineAt());
      return e8.makeMarker(i === undefined ? e8.point() : all[i].start);
    });
    const kill = state.newBuffer && truthy(option(state.template, ":kill-buffer") ?? null);
    const jump = truthy(option(state.template, ":jump-to-captured") ?? null);
    const targets = option(state.template, ":refile-targets");
    const bindings: Record<string, e8.Value> = { "org-capture-is-refiling": true };
    if (targets !== undefined && targets !== null) bindings["org-refile-targets"] = targets;
    e8.letBind(bindings, () => {
      finalize(false, true);
      const config = e8.currentWindowConfiguration();
      try {
        e8.withCurrentBuffer(base, () => {
          e8.saveExcursion(() => {
            e8.gotoChar(e8.markerPosition(pos) ?? e8.point());
            e8.callWithPrefix(arg as e8.PrefixArg, "org-refile");
          });
        });
      } finally {
        e8.setWindowConfiguration(config);
        e8.deleteMarker(pos);
      }
    });
    if (kill && e8.bufferLiveP(e8.getBuffer(base))) {
      e8.withCurrentBuffer(base, () => {
        if (e8.bufferFileName()) e8.call("save-buffer");
      });
      e8.call("kill-buffer", base);
    }
    if (jump) goLastStored();
  },
});

/** Moves where the last capture went to point, as org-refile does when it refiles from a capture. */
e8.defun("org-capture--last-stored-here", () => {
  if (lastStored) e8.deleteMarker(lastStored);
  lastStored = e8.makeMarker(e8.point());
});

/** Where the last capture went, as org-capture-last-stored-marker. */
let lastStored: e8.Marker | undefined;

/** The name of the bookmark Org sets where it last captured, from org-bookmark-names-plist: none when it names none. */
function lastStoredBookmark(): string | undefined {
  const v = e8.variable("org-bookmark-names-plist");
  if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) if (v[i] === ":last-capture" && typeof v[i + 1] === "string") return v[i + 1] as string;
  return undefined;
}

/** Goes to where the last capture went, its marker if its buffer is there, else its bookmark, as org-goto-marker-or-bmk. */
function goLastStored(): void {
  const buffer = lastStored && e8.markerBuffer(lastStored);
  if (lastStored && buffer !== undefined) {
    e8.call("switch-to-buffer", buffer);
    const pos = e8.markerPosition(lastStored) ?? e8.point();
    if (pos < e8.pointMin() || pos > e8.pointMax()) e8.widen();
    e8.gotoChar(pos);
  } else {
    const name = lastStoredBookmark();
    if (name === undefined) e8.userError("Cannot find location");
    jumpTo(name!, "switch-to-buffer");
  }
  // Shown if folded, as org-fold-show-context.
  const all = headings();
  const i = all.findIndex((h, j) => h.start <= e8.point() && (all[j + 1] === undefined || all[j + 1].start > e8.point()));
  if (i >= 0) for (const a of [i, ...ancestors(all, i)]) showHeadingLine(all[a]);
  e8.message("This is the last note stored by a capture process");
}

const gotoLastStored = e8.defineCommand({
  name: "org-capture-goto-last-stored",
  doc: "Go to the location where the last capture note was stored.",
  run: () => goLastStored(),
});

const captureKill = e8.defineCommand({
  name: "org-capture-kill",
  doc: "Abort the capture: the entry goes again, and the windows go back to how they were.",
  run: () => {
    const state = capturing;
    if (!state) throw new Error("This does not seem to be a capture buffer for Org mode");
    e8.withCurrentBuffer(state.buffer, () => {
      runTemplateFunctions(state.template, ":prepare-finalize");
      e8.runHooks("org-capture-prepare-finalize-hook");
    });
    // Then the capture's clock stops, its line going with the entry, and the one it stopped starts again, as Org's finalizing does.
    finishClock(state);
    // From where the capture began inserting to its end marker, as Org kills
    // between :begin-marker and :end-marker, widened. Emacs kills in the
    // capture buffer, whose mark is its own.
    e8.withCurrentBuffer(state.buffer, () => {
      e8.widen();
      const [start, end] = [e8.markerPosition(state.killStart) ?? e8.pointMin(), e8.markerPosition(state.killEnd) ?? e8.pointMax()];
      const mark = e8.mark();
      e8.setMark(start);
      e8.gotoChar(end);
      e8.call("kill-region");
      e8.setMark(mark ?? null);
    });
    e8.deleteMarker(state.killStart);
    e8.deleteMarker(state.killEnd);
    e8.deleteMarker(state.entry);
    e8.deleteMarker(state.entryEnd);
    // Saved, as org-capture-finalize saves when aborting too, unless :no-save.
    if (!truthy(option(state.template, ":no-save") ?? null)) {
      e8.withCurrentBuffer(state.buffer, () => {
        if (e8.bufferFileName()) e8.call("save-buffer");
      });
    }
    endCapture();
    // A buffer visited for the capture goes again.
    if (state.newBuffer && e8.bufferLiveP(e8.getBuffer(state.buffer))) {
      e8.withCurrentBuffer(state.buffer, () => e8.setBufferModified(false));
      e8.call("kill-buffer", state.buffer);
    }
    // As org-capture-kill goes through org-capture-finalize, which runs them.
    runTemplateFunctions(state.template, ":after-finalize");
    e8.runHooks("org-capture-after-finalize-hook");
    e8.message("Capture aborted");
  },
});

e8.defineMinorMode({
  name: "org-capture-mode",
  lighter: " Cap",
  doc: "On in a buffer while a capture is under way in it: C-c C-c finishes the capture and C-c C-k aborts it.",
  bindings: { "C-c C-c": captureFinalize, "C-c C-k": captureKill, "C-c C-w": captureRefile },
});
