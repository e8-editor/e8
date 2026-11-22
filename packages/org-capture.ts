// Capture, after Emacs's org-capture.el: a template's entry goes into its target
// file, which shows narrowed to it in a window of its own until C-c C-c
// files it or C-c C-k takes it away. Emacs captures in an indirect buffer;
// E8 narrows the target buffer itself.

import { bookmarkSet, jumpTo } from "bookmark";
import { alignTags, formatTimestamp, type Heading, headingIndex, headings, isHeadingLine, parseDate, parseHeading, subtreeRegion, today, updateCheckboxCount, updateParentTodoStatistics, validLevel } from "org";
import { clockIn, clockOut, runningEntry } from "org-clock";
import { dateTreeRoot, findDateCreate } from "org-datetree";
import { ancestors, flag, showHeadingLine } from "org-fold";
import { storeLink } from "ol";
import { findBufferVisiting } from "files";
import { type Elem, elementAt, endBeforeBlank } from "org-element";
import { endOfMetaData, ITEM_RE } from "org-list";
import { lineAt, lineStartOrEnd, orgMks, titleWithoutCookies } from "org-macs";
import { charCount, forwardLine, truthy } from "subr";

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
  const now = today(true);
  const day = { year: now.year, month: now.month, day: now.day };
  // The time now, or noon on a fixed day, as tests fix org-current-effective-time.
  const fixed = typeof e8.variable("e8--today") === "string" && e8.variable("e8--today") !== "";
  const time = fixed ? e8.encodeTime([0, now.minute ?? 0, now.hour ?? 0, now.day, now.month, now.year]) : e8.currentTime();
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
    x: () => "",
  };
  let text = fillPass(template, /%(:[-A-Za-z]+|<([^>\n]+)>|[aAcfFikKlLntTuUx])/gi, (m, lineBefore) => {
    const value = m[1];
    if (value.startsWith("<")) return e8.formatTimeString(m[2], time);
    // As org-store-link-plist holds them for the capture.
    if (value.startsWith(":")) return value === ":annotation" ? a : value === ":initial" ? context.initial : "";
    // Each line after the first starts as the line %i is on does.
    if (value === "i") return context.initial.replace(/\n/g, () => `\n${lineBefore}`);
    // %I and the other capitals no letter is, as Emacs's case-folding search finds them and fails.
    const fill = letters[value];
    if (!fill) return e8.signal("wrong-type-argument", "Wrong type argument: char-or-string-p, nil");
    return fill();
  });
  const strings: string[] = [];
  const tagLines: number[] = [];
  text = fillPass(text, /%\^(?:\{([^}]*)\})?([CgGLptTuU])?/gi, (m, lineBefore) => {
    const items = m[1] === undefined ? undefined : m[1].split("|");
    const prompt = items?.[0];
    const dflt = items?.[1];
    const key = m[2];
    if (key === "g" || key === "G") {
      const answer = e8.completingRead(prompt !== undefined ? `${prompt}: ` : "Tags: ", context.tags, { history: "org-tags-history" });
      const tags = answer.split(/[ \t]*:[ \t]*/).filter((t) => t !== "").join(":");
      if (tags === "") return "";
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
      // A heading's tags are aligned, as org-capture-fill-template aligns them where it puts them.
      if (/^\*+ /.test(lineBefore)) tagLines.push(fillLine(text, m.index));
      return `${lineBefore.endsWith(":") ? "" : ":"}${tags}${after === ":" ? "" : ":"}`;
    }
    if (key === "C") {
      // The region and the latest kill, chosen from when there are both.
      const clipboards = [context.initial, ...(kill !== "" ? [kill] : [])];
      return clipboards.length === 1 ? clipboards[0] : e8.readString("Clipboard/kill value: ", { initial: clipboards[0], default: clipboards[0] });
    }
    if (key === "t" || key === "T" || key === "u" || key === "U") {
      const upcase = key === "T" || key === "U";
      const answer = e8.readString(`${prompt !== undefined ? `${prompt} ` : ""}Date${upcase ? "+time" : ""}: `, { history: "org-read-date-history" });
      const d = parseDate(answer, upcase);
      const stamp = formatTimestamp(d, d.hour !== undefined);
      return key === "u" || key === "U" ? `[${stamp}]` : `<${stamp}>`;
    }
    if (key === "L" || key === "p") e8.userError(`E8 does not fill %^${key} yet`);
    // Keys in other cases, as a case-folding search finds them, are none Org knows.
    if (key !== undefined) e8.signal("error", `Unknown template placeholder: "%^${key}"`);
    const label = prompt ?? "Enter string";
    const answer = e8.completingRead(dflt !== undefined && dflt !== "" ? `${label} (default ${dflt}): ` : `${label}: `, items?.slice(2) ?? [], {
      default: dflt,
    });
    strings.push(answer);
    return answer;
  });
  text = fillPass(text, /%\\([1-9][0-9]*)/g, (m) => {
    const answer = strings[Number(m[1]) - 1];
    return answer ?? e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil");
  });
  // No blank lines first: from the line the text starts on.
  const firstText = text.search(/[^ \t\n]/);
  if (firstText < 0) text = "";
  else {
    const lineStart = text.lastIndexOf("\n", firstText - 1) + 1;
    const dropped = text.slice(0, lineStart).split("\n").length - 1;
    for (let i = 0; i < tagLines.length; i++) tagLines[i] -= dropped;
    text = text.slice(lineStart);
    // A newline last, after the rest of the line the text ends on.
    const lastText = text.search(/[^ \t\n][ \t\n]*$/);
    const lineEnd = text.indexOf("\n", lastText);
    text = `${lineEnd < 0 ? text : text.slice(0, lineEnd)}\n`;
  }
  text = untabify(text);
  // %? is where the cursor goes, its first, as org-capture--position-cursor finds it.
  let cursor: number | undefined;
  const q = text.indexOf("%?");
  if (q >= 0) {
    cursor = charCount(text.slice(0, q));
    text = text.slice(0, q) + text.slice(q + 2);
  }
  return { text, cursor, tagLines };
}

/** Which line of TEXT position AT is on, from 0. */
const fillLine = (text: string, at: number): number => text.slice(0, at).split("\n").length - 1;

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
  }
  | undefined;


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

/** The buffer visiting a target's file, visited if need be, as org-capture-target-buffer. */
function targetBuffer(file: e8.Value | undefined): string {
  const name = expandFile(file);
  return findBufferVisiting(name) ?? e8.findFileNoselect(name);
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
function setTargetLocation(t: CaptureTemplate, prepend: boolean): Target {
  const target = (Array.isArray(t[3]) ? t[3] : [t[3]]) as e8.Value[];
  const kind = typeof target[0] === "symbol" ? e8.symbolName(target[0]) : String(target[0]);
  /** The heading with this title under the one at `under`, as org-find-olp looks for each. */
  const child = (title: string, under: Heading | undefined): Heading | undefined => {
    const all = headings();
    const [start, end] = under === undefined ? [0, e8.bufferSize()] : subtreeRegion(all, all.findIndex((x) => x.start === under.start));
    const level = under === undefined ? Math.min(...all.map((h) => h.level)) : under.level + 1;
    return all.find((h) => h.start >= start && h.start < end && titleWithoutCookies(h.title) === title && (under === undefined ? true : h.level === level));
  };
  /** The heading an outline path names, as org-find-olp, which signals when one is missing. */
  const olp = (path: string[]): Heading | undefined => {
    let h: Heading | undefined;
    path.forEach((title, n) => {
      const found = child(title, h);
      if (!found) e8.signal("error", `Heading not found on level ${n + 1}: ${title}`);
      h = found;
    });
    return h;
  };
  const inBuffer = (buffer: string, find: () => Omit<Target, "buffer">): Target =>
    e8.withCurrentBuffer(buffer, () => e8.saveExcursion(() => e8.saveRestriction(() => (e8.widen(), { buffer, ...find() }))));
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
        // Under the outline path's heading, else a DATE_TREE (or WEEK_TREE) heading or the whole buffer, as Org's capture asks org-datetree.
        const root = dateTreeRoot(grouping, parent?.start);
        return { pos: findDateCreate(today(), grouping, root.base, root.start, root.end, root.step), entryP: true };
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
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  emptyLinesBefore(emptyLines(t, ":empty-lines-before"));
  // The template as a subtree at the target's level, as org-paste-subtree puts it.
  const first = /^(\*+) /m.exec(filled.text)?.[1].length ?? level;
  const shift = level - first;
  let cursor = filled.cursor;
  let offset = 0;
  const leveled = filled.text
    .split("\n")
    .map((line) => {
      const m = /^(\*+) /.exec(line);
      let out = line;
      if (m && shift !== 0) {
        out = "*".repeat(Math.max(1, m[1].length + shift)) + line.slice(m[1].length);
        if (cursor !== undefined && cursor > offset) cursor += out.length - line.length;
      }
      offset += line.length + 1;
      return out;
    })
    .join("\n");
  const beg = e8.point();
  e8.insert(leveled);
  const end = e8.point();
  // Tags aligned where the entry was demoted or %^g put them, as Org aligns them; others left as written.
  for (let l = lineAt(beg); l < lineAt(end); l++) {
    const h = parseHeading(l);
    if (h && h.tagsAt !== undefined && (shift !== 0 || filled.tagLines.includes(l - lineAt(beg)))) alignTags(l);
  }
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
  // With its last newline at the end of the buffer, else without, as org-capture-narrow is given.
  captureNarrow(t, beg, endPos === e8.bufferSize() ? endPos : endPos - 1);
  e8.gotoChar(cursor === undefined ? beg : beg + cursor);
  return { beg, end: endPos, level, cursor: e8.point() };
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
  return { beg, end: endPos, level: 0, cursor: e8.point() };
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
  if (!/^[ \t]*(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.test(template)) template = `- ${template.split("\n").join("\n  ")}`;
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
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  // In a list, at most one blank line between items, and none before a prepended one.
  const between = Math.min(1, emptyLines(t, ":empty-lines-before"));
  if (!(list && prepend)) emptyLinesBefore(list ? between : emptyLines(t, ":empty-lines-before"));
  const start = e8.lineStart(lineAt());
  e8.insert(`${template.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "")}\n`);
  const endMarker = e8.makeMarker(e8.point());
  if (list) {
    const indent = /^[ \t]*/.exec(e8.lineText(lineAt(list.begin === start ? e8.markerPosition(endMarker)! : list.begin)))![0].length;
    e8.saveExcursion(() => {
      e8.gotoChar(start);
      while (e8.point() < (e8.markerPosition(endMarker) as number)) {
        if (indent > 0) e8.insert(" ".repeat(indent));
        if (!forwardLine(1)) break;
      }
      e8.gotoChar(start);
      e8.call("org-list-repair");
    });
  }
  if (!(list && !prepend)) emptyLinesAfter(list ? Math.min(1, emptyLines(t, ":empty-lines-after")) : emptyLines(t, ":empty-lines-after"));
  const stop = e8.markerPosition(endMarker) as number;
  e8.deleteMarker(endMarker);
  const cursor = takeCursor(start, stop);
  const last = cursor === undefined ? stop : stop - 1;
  captureNarrow(t, start, last - 1);
  e8.gotoChar(cursor ?? start);
  return { beg: start, end: last, level: 0, cursor: e8.point() };
}

/** Places the template as a table line, as org-capture-place-table-line: in the first table there, else a new one. */
function placeTableLine(t: CaptureTemplate, where: Target, filled: Filled, prepend: boolean): Placed {
  const trimmed = withCursor(filled).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  const text = /^[ \t]*\+-/m.test(trimmed) ? `| ${CURSOR}Bad template |\n` : `${trimmed}\n`;
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
      if (e.type === "table") {
        table = e;
        break;
      }
    }
  }
  let tableStart: number;
  let tableEnd: number;
  if (table) {
    tableStart = table.begin;
    tableEnd = lineStartOrEnd(lineAt(endBeforeBlank(table)) + 1);
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
  if (where.insertHere) e8.gotoChar(where.exact ?? e8.point());
  else if (spec) {
    // After the line delta lines from the Nth rule, as org-table-hlines numbers them.
    const lines = rows();
    const hlines = lines.filter((l) => /^[ \t]*\|-/.test(e8.lineText(l)));
    const hline = hlines[spec[1].length - 1];
    if (hline === undefined) e8.signal("error", `Invalid table line specification ${JSON.stringify(pos)}`);
    const delta = Number(spec[2]);
    const line = hline - lineAt(tableStart);
    const target = lineAt(tableStart) + line + delta + (delta < 0 ? 0 : -1) + 1;
    e8.gotoChar(target >= lineAt(tableEnd) ? tableEnd : e8.lineStart(Math.max(lineAt(tableStart), target)));
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
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  const start = e8.point();
  e8.insert(text);
  let stop = e8.point();
  const cursor = takeCursor(start, stop);
  if (cursor !== undefined) stop--;
  captureNarrow(t, start, stop - 1);
  e8.gotoChar(cursor ?? start);
  return { beg: start, end: stop, level: 0, cursor: e8.point() };
}

/**
 * Puts the entry a template makes into its target and shows it there,
 * narrowed, as org-capture-place-entry and org-capture-place-template do.
 */
function captureWith(key: string): void {
  const t = captureTemplates().find((x) => x[0] === key);
  if (!t) throw new Error(`No capture template referred to by "${key}" keys`);
  const [, , rawType, target] = t;
  // An empty template is Org's default for the type, as org-capture-set-plist gives it.
  const type = rawType === undefined || rawType === null || rawType === "" ? "entry" : String(typeof rawType === "symbol" ? e8.symbolName(rawType) : rawType);
  if (!["entry", "plain", "item", "checkitem", "table-line"].includes(type)) e8.signal("error", `Invalid capture type: ${type}`);
  const template =
    typeof t[4] === "string" && /\S/.test(t[4])
      ? t[4]
      : ({ item: "- %?", checkitem: "- [ ] %?", "table-line": "| %? |", entry: "* %?\n  %a" } as Record<string, string>)[type] ?? "";
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
        // Links as their descriptions, as org-clock-heading shows them.
        const title = (h?.title ?? "").replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_m, l: string, d?: string) => d ?? l);
        return { title, link: path === undefined ? "" : `[[file:${e8.abbreviateFileName(path)}::*${title}][${title}]]` };
      })
    : undefined;
  const prepend = truthy(option(t, ":prepend") ?? null);
  const where = setTargetLocation(t, prepend);
  const buffer = where.buffer;
  const modified = e8.withCurrentBuffer(buffer, () => e8.bufferModified());
  const tags = e8.withCurrentBuffer(buffer, () => [...new Set(headings().flatMap((h) => h.tags))]);
  const filled = fillTemplate(template, { annotation: link, initial, tags, file: originalFile, clock: clockContext });
  const placed = e8.withCurrentBuffer(buffer, () => {
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
    e8.callWithPrefix(1, "org-capture-mode");
    return r;
  });
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
  };
  // :clock-in starts a clock on the entry, stopping one running, as org-capture does.
  const clockOption = option(t, ":clock-in");
  if (clockOption !== undefined && clockOption !== null && clockOption !== false) {
    const running = runningEntry();
    if (running) capturing.interrupted = { buffer: running.buffer, marker: e8.withCurrentBuffer(running.buffer, () => e8.makeMarker(running.start)) };
    const resume = option(t, ":clock-resume");
    capturing.resume = resume !== undefined && resume !== null && resume !== false;
    // On the heading the capture is in, widened, as plain text's is its target's.
    e8.withCurrentBuffer(buffer, () => {
      e8.saveExcursion(() =>
        e8.saveRestriction(() => {
          e8.widen();
          e8.gotoChar(placed.beg);
          clockIn();
          // The clock's drawer stays shown, as Org folds it in the indirect buffer it captures in, not the file's.
          const h = headings().filter((x) => x.start <= placed.beg).at(-1);
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
  e8.gotoChar(placed.cursor);
  // Finished at once, as org-capture does with :immediate-finish.
  if (truthy(option(t, ":immediate-finish") ?? null)) e8.call(captureFinalize);
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
  params: [{ name: "goto", kind: "prefix" }],
  run: (goto: e8.PrefixArg) => {
    // With C-u C-u, to where the last capture went, as org-capture-goto-last-stored.
    if (Array.isArray(goto) && goto[0] === 16) return goLastStored();
    // As org-capture-select-template, Org's one default template when there are none.
    const chosen = orgMks(captureTemplates() as unknown as e8.Value[][], "Select a capture template\n=========================", "Template key: ", [
      ["C", "Customize org-capture-templates"],
      ["q", "Abort"],
    ]);
    if (chosen === "q") e8.userError("Abort");
    if (chosen === "C") {
      e8.call("describe-variable", "org-capture-templates");
      return;
    }
    captureWith(String((chosen as e8.Value[])[0]));
  },
});

const captureFinalize = e8.defineCommand({
  name: "org-capture-finalize",
  doc: "Finish the capture: the entry stays in its file, which is saved, and the windows go back to how they were.",
  run: () => {
    const buffer = capturing?.buffer;
    const state = capturing;
    if (state) e8.withCurrentBuffer(state.buffer, () => e8.runHooks("org-capture-prepare-finalize-hook"));
    // The capture's clock stops, and the one it stopped starts again with :clock-resume.
    if (state?.clocked) {
      clockOut(true);
      const interrupted = state.interrupted;
      if (interrupted && state.resume && e8.bufferList().includes(interrupted.buffer)) {
        e8.withCurrentBuffer(interrupted.buffer, () => {
          e8.saveExcursion(() => {
            e8.gotoChar(e8.markerPosition(interrupted.marker) ?? 0);
            clockIn();
          });
        });
        e8.message("Interrupted clock has been resumed");
      }
      if (interrupted) e8.deleteMarker(interrupted.marker);
    }
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
    // A table line's table aligned, if point is still in it, as org-capture-finalize does.
    if (state?.type === "table-line") {
      e8.withCurrentBuffer(state.buffer, () =>
        e8.saveRestriction(() => {
          e8.widen();
          if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-align");
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
      e8.withCurrentBuffer(state.buffer, () => e8.saveRestriction(() => (e8.widen(), e8.runHooks("org-capture-before-finalize-hook"))));
    }
    endCapture();
    if (buffer !== undefined && !(state && truthy(option(state.template, ":no-save") ?? null))) {
      e8.withCurrentBuffer(buffer, () => {
        if (e8.bufferFileName()) e8.call("save-buffer");
      });
    }
    e8.runHooks("org-capture-after-finalize-hook");
    // To the entry, as org-capture-goto-last-stored, with :jump-to-captured or C-u.
    if (state && (truthy(option(state.template, ":jump-to-captured") ?? null) || e8.prefixArg() !== null)) goLastStored();
    if (state) {
      e8.deleteMarker(state.entry);
      e8.deleteMarker(state.entryEnd);
    }
  },
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
    // The capture's clock goes with its entry, and the one it stopped starts again.
    if (state.clocked && runningEntry()?.buffer === state.buffer) e8.call("org-clock-cancel");
    if (state.clocked && state.interrupted && state.resume && e8.bufferList().includes(state.interrupted.buffer)) {
      const interrupted = state.interrupted;
      e8.withCurrentBuffer(interrupted.buffer, () => {
        e8.saveExcursion(() => {
          e8.gotoChar(e8.markerPosition(interrupted.marker) ?? 0);
          clockIn();
        });
      });
    }
    e8.withCurrentBuffer(state.buffer, () => e8.runHooks("org-capture-prepare-finalize-hook"));
    // The entry as it is now: what the narrowing shows, and the newline after
    // it, or where it went when not narrowed, as Org's begin and end markers.
    e8.withCurrentBuffer(state.buffer, () => {
      const narrowed = e8.pointMin() > 0 || e8.pointMax() < e8.bufferSize();
      const [start, end] = narrowed
        ? [e8.pointMin(), e8.pointMax()]
        : [e8.markerPosition(state.entry) ?? e8.pointMin(), Math.max(0, (e8.markerPosition(state.entryEnd) ?? e8.pointMax()) - 1)];
      e8.widen();
      // Killed, as org-capture-kill does, so it can be yanked back. Emacs
      // kills in the capture buffer, whose mark is its own.
      const mark = e8.mark();
      e8.setMark(start);
      e8.gotoChar(end < e8.bufferSize() ? end + 1 : end);
      e8.call("kill-region");
      e8.setMark(mark ?? null);
      if (!state.modified) e8.setBufferModified(false);
    });
    e8.deleteMarker(state.entry);
    e8.deleteMarker(state.entryEnd);
    endCapture();
    // As org-capture-kill goes through org-capture-finalize, which runs it.
    e8.runHooks("org-capture-after-finalize-hook");
    e8.message("Capture aborted");
  },
});

e8.defineMinorMode({
  name: "org-capture-mode",
  lighter: " Cap",
  doc: "On in a buffer while a capture is under way in it: C-c C-c finishes the capture and C-c C-k aborts it.",
  bindings: { "C-c C-c": captureFinalize, "C-c C-k": captureKill },
});
