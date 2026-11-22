// Capture, after Emacs's org-capture.el: a template's entry goes into its target
// file, which shows narrowed to it in a window of its own until C-c C-c
// files it or C-c C-k takes it away. Emacs captures in an indirect buffer;
// E8 narrows the target buffer itself.

import { bookmarkSet, jumpTo } from "bookmark";
import { alignTags, formatTimestamp, type Heading, headings, parseDate, parseHeading, subtreeRegion, today, updateCheckboxCount, updateParentTodoStatistics, validLevel } from "org";
import { clockIn, clockOut, runningEntry } from "org-clock";
import { dateTreeRoot, findDateCreate } from "org-datetree";
import { ancestors, flag, showHeadingLine } from "org-fold";
import { storeLink } from "ol";
import { endOfMetaData } from "org-list";
import { lineAt, orgMks, titleWithoutCookies } from "org-macs";
import { charCount, truthy } from "subr";

e8.defineVariable({
  name: "org-capture-templates",
  doc:
    "The capture templates: lists of a key, a description, the type (entry or plain), a target such as " +
    '["file", NAME], ["file+headline", NAME, HEADING], ["file+olp", NAME, HEADING, SUBHEADING...] or ' +
    '["file+olp+datetree", NAME, HEADING...], the template text, and options such as ":tree-type", "week".',
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
    wconf: e8.WindowConfiguration;
    /** Where the captured entry ends, as Org's :end-marker. */
    entryEnd: e8.Marker;
    /** Where the captured entry starts, to go to with :jump-to-captured and remember as the last stored. */
    entry: e8.Marker;
  }
  | undefined;

/**
 * Puts the entry a template makes into its target and shows it there,
 * narrowed, as org-capture-place-entry and org-capture-place-template do.
 */
function captureWith(key: string): void {
  const t = captureTemplates().find((x) => x[0] === key);
  if (!t) throw new Error(`No capture template referred to by "${key}" keys`);
  const [, , type, target, template] = t;
  if (type !== "entry" && type !== "plain") throw new Error(`E8 captures only entries and plain text, not ${type}`);
  if (capturing) throw new Error("A capture is already under way: C-c C-c or C-c C-k finishes it");
  // A relative name is in org-directory, as org-capture-expand-file expands it.
  const dir = e8.variable("org-directory");
  const file = target[1] === "" || target[1] === undefined
    ? String(e8.variable("org-default-notes-file") ?? "~/.notes")
    : e8.expandFileName(target[1], typeof dir === "string" ? e8.expandFileName(dir) : undefined);
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
  const buffer = e8.findFileNoselect(file);
  const modified = e8.withCurrentBuffer(buffer, () => e8.bufferModified());
  const tags = e8.withCurrentBuffer(buffer, () => [...new Set(headings().flatMap((h) => h.tags))]);
  const filled = fillTemplate(template, { annotation: link, initial, tags, file: originalFile, clock: clockContext });
  const prepend = truthy(option(t, ":prepend") ?? null);
  const placed = e8.withCurrentBuffer(buffer, () => {
    e8.widen();
    let level = 1;
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
    /** Files the entry under a heading, after its subtree. */
    // A plain capture goes into the heading's own text, at its end, or after its meta data with :prepend.
    const under = (h: Heading) => {
      const all = headings();
      const i = all.findIndex((x) => x.start === h.start);
      // A level below, odd with org-odd-levels-only, as org-get-valid-level gives it.
      level = validLevel(h.level, 1);
      if (type === "plain") e8.gotoChar(prepend ? endOfMetaData(h, true) : (all[i + 1]?.start ?? e8.pointMax()));
      // First, before its first child, as outline-next-heading; else after its subtree.
      else e8.gotoChar(prepend ? (all[i + 1]?.start ?? e8.pointMax()) : subtreeRegion(all, i)[1]);
    };
    if (target[0] === "file+headline") {
      const name = target[2] ?? "";
      // Its statistics cookies are no part of the name it is found by.
      let h = headings().find((x) => titleWithoutCookies(x.title) === name);
      if (!h) {
        e8.gotoChar(e8.bufferSize());
        if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
        e8.insert(`* ${name}\n`);
        h = headings().find((x) => x.title === name) as Heading;
      }
      under(h);
    } else if (target[0] === "file+olp") {
      const h = olp(target.slice(2));
      if (h) under(h);
      else e8.gotoChar(e8.bufferSize());
    } else if (target[0] === "file+olp+datetree") {
      const parent = olp(target.slice(2));
      const tree = option(t, ":tree-type");
      const grouping = tree === "week" ? "week" : tree === "month" ? "month" : "day";
      // Under the outline path's heading, else a DATE_TREE (or WEEK_TREE) heading or the whole buffer, widened, as Org's capture asks org-datetree.
      const at = e8.saveRestriction(() => {
        if (parent === undefined) e8.widen();
        const root = dateTreeRoot(grouping, parent?.start);
        return findDateCreate(today(), grouping, root.base, root.start, root.end, root.step);
      });
      under(headings().find((h) => h.start === at) as Heading);
    } else if (target[0] === "file") {
      // At the start with :prepend, before the first heading for an entry, as org-capture-place-entry.
      if (!prepend) e8.gotoChar(e8.bufferSize());
      else if (type === "plain") e8.gotoChar(e8.pointMin());
      else e8.gotoChar(headings().find((h) => h.start >= e8.pointMin())?.start ?? e8.pointMax());
    } else {
      throw new Error(`E8 does not capture to ${target[0]} targets`);
    }
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    // The blank lines where it goes go, and as many as the template says
    // come instead, as org-capture-empty-lines-before has it.
    {
      const here = e8.point();
      let back = here;
      while (back > e8.pointMin() && /[ \t\n\r]/.test(e8.bufferText(back - 1, back))) back--;
      if (back < here) back = e8.lineEnd(lineAt(back)) < here ? e8.lineEnd(lineAt(back)) + 1 : here;
      if (back < here) e8.deleteRegion(back, here);
      e8.gotoChar(back);
      e8.insert("\n".repeat(emptyLines(t, ":empty-lines-before")));
    }
    // The template as a subtree at the target's level, as org-paste-subtree puts it; plain text as it is.
    const first = /^(\*+) /m.exec(filled.text)?.[1].length ?? level;
    const shift = type === "plain" ? 0 : level - first;
    const lines = filled.text.split("\n");
    let cursor = filled.cursor;
    let offset = 0;
    const leveled = lines
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
    if (type !== "plain") e8.message(`Clipboard pasted as level ${level} subtree`);
    // Blank lines after it go too, and the template's come, as org-capture-empty-lines-after.
    {
      const after = e8.point();
      let q = after;
      while (q < e8.pointMax() && /^[ \t]*$/.test(e8.lineText(lineAt(q))) && e8.lineEnd(lineAt(q)) < e8.pointMax()) q = e8.lineEnd(lineAt(q)) + 1;
      if (q > after) e8.deleteRegion(after, q);
      e8.saveExcursion(() => e8.insert("\n".repeat(emptyLines(t, ":empty-lines-after"))));
    }
    const endPos = e8.point();
    // Narrowed to it, unless :unnarrowed, as org-capture-narrow.
    // Plain text without its last newline, an entry with it at the end of the buffer.
    const narrowEnd = type === "plain" ? Math.max(beg, endPos - 1) : endPos === e8.bufferSize() ? endPos : endPos - 1;
    if (!truthy(option(t, ":unnarrowed") ?? null)) e8.narrowToRegion(beg, narrowEnd);
    e8.gotoChar(cursor === undefined ? beg : beg + cursor);
    e8.callWithPrefix(1, "org-capture-mode");
    return { beg, end: endPos, level, cursor: e8.point() };
  });
  capturing = {
    buffer,
    from,
    point,
    level: placed.level,
    modified,
    template: t,
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
