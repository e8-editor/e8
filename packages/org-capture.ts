// Capture, after Emacs's org-capture.el: a template's entry goes into its target
// file, which shows narrowed to it in a window of its own until C-c C-c
// files it or C-c C-k takes it away. Emacs captures in an indirect buffer;
// E8 narrows the target buffer itself.

import { bookmarkSet, jumpTo } from "bookmark";
import { alignTags, formatTimestamp, type Heading, headings, parseDate, parseHeading, subtreeRegion, today, updateParentTodoStatistics } from "org";
import { clockIn, clockOut, runningEntry } from "org-clock";
import { findDateCreate } from "org-datetree";
import { endOfMetaData } from "org-list";
import { lineAt, orgMks, titleWithoutCookies } from "org-macs";
import { charCount, truthy } from "subr";

e8.defineVariable({
  name: "org-capture-templates",
  doc:
    "The capture templates: lists of a key, a description, the type (entry), a target such as " +
    '["file", NAME], ["file+headline", NAME, HEADING], ["file+olp", NAME, HEADING, SUBHEADING...] or ' +
    '["file+olp+datetree", NAME, HEADING...], the template text, and options such as ":tree-type", "week".',
  value: [],
});
for (const [name, doc] of [
  ["org-capture-before-finalize-hook", "Run before the capture is finished, in the capture's buffer, narrowed to the entry."],
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

/** A template's option, as its properties plist gives it. */
/** How many blank lines go before or after a captured entry: the option, else :empty-lines, else none. */
function emptyLines(t: CaptureTemplate, name: string): number {
  const n = option(t, name) ?? option(t, ":empty-lines");
  return typeof n === "number" && n > 0 ? n : 0;
}

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

/** A link to point's place, as org-store-link makes one for %a: the heading in an Org file, else the line. */
function annotation(): string {
  const file = e8.bufferFileName();
  if (file === undefined) return "";
  const path = e8.abbreviateFileName(file);
  if (e8.derivedModeP("org-mode")) {
    const h = headings().filter((x) => x.start <= e8.point()).at(-1);
    return h ? `[[file:${path}::*${h.title}][${h.title}]]` : `[[file:${path}]]`;
  }
  const line = e8.lineText(lineAt()).trim();
  return line === "" ? `[[file:${path}]]` : `[[file:${path}::${line}]]`;
}

/**
 * Fills a template's escapes in one pass of REGEXP over TEXT, as
 * org-capture-fill-template does each kind: an escape after an odd number
 * of backslashes is left as written, and half the backslashes go, as
 * org-capture-escaped-% unescapes them. REPLACE gets the match and the
 * line before it as filled so far.
 */
function fillPass(text: string, regexp: RegExp, replace: (m: RegExpExecArray, lineBefore: string) => string): string {
  let out = "";
  let last = 0;
  regexp.lastIndex = 0;
  for (let m = regexp.exec(text); m !== null; m = regexp.exec(text)) {
    let n = 0;
    while (m.index - 1 - n >= last && text[m.index - 1 - n] === "\\") n++;
    out += text.slice(last, m.index - n) + "\\".repeat(n - Math.floor((n + 1) / 2));
    out += n % 2 === 1 ? m[0] : replace(m, /[^\n]*$/.exec(out)![0]);
    last = m.index + m[0].length;
    if (m[0] === "") regexp.lastIndex++;
  }
  return out + text.slice(last);
}

/** A link's parts, as the template's %A, %l and %L take them from %a. */
const LINK = /\[\[(.*?)\](\[.*?\])?\]/;

/** Tabs as spaces to the next tab stop, as untabify makes them. */
function untabify(text: string): string {
  const width = Number(e8.variable("tab-width") ?? 8) || 8;
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      for (const c of line) out += c === "\t" ? " ".repeat(width - (charCount(out) % width)) : c;
      return out;
    })
    .join("\n");
}

/**
 * A template's text with its escapes filled in, as org-capture-fill-template
 * does: first %<format>, %:keyword and the letters (%a, %A, %c, %f, %F, %i,
 * %k, %K, %l, %L, %n, %t, %T, %u, %U, %x), then in turn what %^ asks for
 * (%^{prompt|default|choice...}, %^g, %^G, %^t, %^T, %^u, %^U, %^C), then
 * %\N for the Nth answer; and where %? puts the cursor. Blank lines go from
 * its start, and blanks from its end.
 */
function fillTemplate(template: string, context: Context = { annotation: "", initial: "", tags: [] }): { text: string; cursor?: number } {
  const now = today(true);
  const day = { year: now.year, month: now.month, day: now.day };
  const time = e8.encodeTime([0, now.minute ?? 0, now.hour ?? 0, now.day, now.month, now.year]);
  const a = context.annotation === "[[]]" ? "" : context.annotation;
  let kill = "";
  try {
    kill = e8.currentKill(0);
  } catch {
    // An empty kill ring, as Emacs's (and kill-ring (current-kill 0)).
  }
  const letters: Record<string, () => string> = {
    a: () => a,
    A: () => (LINK.test(a) ? a.replace(LINK, "[[$1][%^{Link description}]]") : a),
    l: () => (LINK.test(a) ? a.replace(LINK, "[[$1]]") : a),
    L: () => (LINK.test(a) ? a.replace(LINK, "$1") : a),
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
  let text = fillPass(template, /%(:[-A-Za-z]+|<([^>\n]+)>|[aAcfFikKlLntTuUx])/g, (m, lineBefore) => {
    const value = m[1];
    if (value.startsWith("<")) return e8.formatTimeString(m[2], time);
    // As org-store-link-plist holds them for the capture.
    if (value.startsWith(":")) return value === ":annotation" ? a : value === ":initial" ? context.initial : "";
    // Each line after the first starts as the line %i is on does.
    if (value === "i") return context.initial.replace(/\n/g, `\n${lineBefore}`);
    return letters[value]();
  });
  const strings: string[] = [];
  text = fillPass(text, /%\^(?:\{([^}]*)\})?([CgGLptTuU])?/g, (m, lineBefore) => {
    const items = m[1] === undefined ? undefined : m[1].split("|");
    const prompt = items?.[0];
    const dflt = items?.[1];
    const key = m[2];
    if (key === "g" || key === "G") {
      const answer = e8.completingRead(prompt !== undefined ? `${prompt}: ` : "Tags: ", context.tags, { history: "org-tags-history" });
      const tags = answer.split(/[ \t]*:[ \t]*/).filter((t) => t !== "").join(":");
      if (tags === "") return "";
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
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
    const label = prompt ?? "Enter string";
    const answer = e8.completingRead(dflt !== undefined && dflt !== "" ? `${label} (default ${dflt}): ` : `${label}: `, items?.slice(2) ?? [], {
      default: dflt,
    });
    strings.push(answer);
    return answer;
  });
  text = untabify(fillPass(text, /%\\([1-9][0-9]*)/g, (m) => strings[Number(m[1]) - 1] ?? ""));
  // %? is where the cursor goes, its first, as org-capture--position-cursor finds it.
  let cursor: number | undefined;
  const q = text.indexOf("%?");
  if (q >= 0) {
    cursor = charCount(text.slice(0, q));
    text = text.slice(0, q) + text.slice(q + 2);
  }
  // As org-capture-fill-template ends: no blank lines first, and a newline last.
  const lead = /^[ \t\n]*/.exec(text)![0];
  const cut = lead.lastIndexOf("\n") + 1;
  if (cursor !== undefined) cursor = Math.max(0, cursor - charCount(text.slice(0, cut)));
  text = text.slice(cut);
  let body = text.replace(/[ \t\n]*$/, "");
  // A %? after the text keeps the blank it is on, as Org trims with %? still in the text.
  if (cursor !== undefined && cursor > charCount(body)) body = [...text].slice(0, cursor).join("");
  const lastLine = body.length === 0 ? "" : text.slice(body.length).split("\n")[0];
  text = body.length === 0 ? "" : `${body}${lastLine}\n`;
  if (cursor !== undefined) cursor = Math.min(cursor, charCount(text));
  return { text, cursor };
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
    interrupted?: { buffer: string; marker: e8.Marker };
    resume?: boolean;
    template: CaptureTemplate;
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
  // A marker, as the buffer the capture came from stays editable below it.
  const point = e8.makeMarker(e8.point());
  const mark = e8.mark();
  const initial = e8.regionActive() && mark !== undefined && mark !== e8.point()
    ? e8.bufferSubstringNoProperties(Math.min(mark, e8.point()), Math.max(mark, e8.point()))
    : "";
  const link = annotation();
  const originalFile = e8.bufferFileName();
  const running = runningEntry();
  const clockContext = running
    ? e8.withCurrentBuffer(running.buffer, () => {
        const h = headings().find((x) => x.start === running.start);
        const path = e8.bufferFileName();
        const title = h?.title ?? "";
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
      level = h.level + 1;
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
      const all = headings();
      const [start, end] = parent === undefined ? [0, e8.bufferSize()] : subtreeRegion(all, all.findIndex((x) => x.start === parent.start));
      const grouping = option(t, ":tree-type");
      const now = today();
      const at = findDateCreate(now, grouping === "week" ? "week" : grouping === "month" ? "month" : "day", parent === undefined ? 1 : parent.level + 1, start, end);
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
    for (let l = lineAt(beg); l < lineAt(end); l++) {
      const h = parseHeading(l);
      if (h && h.tagsAt !== undefined) alignTags(l);
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
    if (!truthy(option(t, ":unnarrowed") ?? null)) e8.narrowToRegion(beg, endPos === e8.bufferSize() ? endPos : endPos - 1);
    e8.gotoChar(cursor === undefined ? beg : beg + cursor);
    e8.callWithPrefix(1, "org-capture-mode");
    return { beg, end: endPos, level, cursor: e8.point() };
  });
  capturing = { buffer, from, point, level: placed.level, modified, template: t, entry: e8.withCurrentBuffer(buffer, () => e8.makeMarker(placed.beg)) };
  // :clock-in starts a clock on the entry, stopping one running, as org-capture does.
  const clockOption = option(t, ":clock-in");
  if (clockOption !== undefined && clockOption !== null && clockOption !== false) {
    const running = runningEntry();
    if (running) capturing.interrupted = { buffer: running.buffer, marker: e8.withCurrentBuffer(running.buffer, () => e8.makeMarker(running.start)) };
    const resume = option(t, ":clock-resume");
    capturing.resume = resume !== undefined && resume !== null && resume !== false;
    e8.withCurrentBuffer(buffer, () => {
      e8.saveExcursion(() => {
        e8.gotoChar(placed.beg);
        clockIn();
      });
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
  e8.call("delete-other-windows");
  e8.setWindowBuffer(undefined, state.from);
  e8.gotoChar(e8.markerPosition(state.point) ?? e8.point());
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
    if (Array.isArray(goto) && goto[0] === 16) return e8.call(gotoLastStored);
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
        e8.message("Interrupted clock resumed");
      }
      if (interrupted) e8.deleteMarker(interrupted.marker);
    }
    // The parent's statistics cookie counts the new entry, as
    // org-capture-finalize brings it up to date from the entry's heading.
    if (buffer !== undefined) {
      e8.withCurrentBuffer(buffer, () =>
        e8.saveExcursion(() => {
          const start = e8.pointMin();
          e8.saveRestriction(() => {
            e8.widen();
            if (parseHeading(lineAt(start))) updateParentTodoStatistics(lineAt(start));
          });
        }),
      );
    }
    if (state) e8.withCurrentBuffer(state.buffer, () => e8.runHooks("org-capture-before-finalize-hook"));
    // Where it went, as the bookmark org-capture-last-stored, as org-capture-store-last-position.
    if (state) {
      e8.withCurrentBuffer(state.buffer, () =>
        e8.saveExcursion(() => {
          e8.gotoChar(e8.markerPosition(state.entry) ?? e8.point());
          try {
            bookmarkSet(lastStoredBookmark());
          } catch (err) {
            e8.message(`Bookmark set error: (error ${JSON.stringify(err instanceof Error ? err.message : String(err))})`);
          }
        }),
      );
    }
    endCapture();
    if (buffer !== undefined && !(state && truthy(option(state.template, ":no-save") ?? null))) {
      e8.withCurrentBuffer(buffer, () => {
        if (e8.bufferFileName()) e8.call("save-buffer");
      });
    }
    e8.runHooks("org-capture-after-finalize-hook");
    // To the entry, as org-capture-goto-last-stored, with :jump-to-captured or C-u.
    if (state && (truthy(option(state.template, ":jump-to-captured") ?? null) || e8.prefixArg() !== null)) {
      e8.call("switch-to-buffer", state.buffer);
      e8.gotoChar(e8.markerPosition(state.entry) ?? e8.point());
    }
    if (state) e8.deleteMarker(state.entry);
  },
});

/** The name of the bookmark Org sets where it last captured, from org-bookmark-names-plist. */
function lastStoredBookmark(): string {
  const v = e8.variable("org-bookmark-names-plist");
  if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) if (v[i] === ":last-capture" && typeof v[i + 1] === "string") return v[i + 1] as string;
  return "org-capture-last-stored";
}

const gotoLastStored = e8.defineCommand({
  name: "org-capture-goto-last-stored",
  doc: "Go to the location where the last capture note was stored.",
  run: () => {
    jumpTo(lastStoredBookmark(), "switch-to-buffer");
    e8.message("This is the last note stored by a capture process");
  },
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
    // The entry as it is now: what the narrowing shows, and the newline after it.
    e8.withCurrentBuffer(state.buffer, () => {
      const [start, end] = [e8.pointMin(), e8.pointMax()];
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
    endCapture();
    e8.message("Capture aborted");
  },
});

e8.defineMinorMode({
  name: "org-capture-mode",
  lighter: " Cap",
  doc: "On in a buffer while a capture is under way in it: C-c C-c finishes the capture and C-c C-k aborts it.",
  bindings: { "C-c C-c": captureFinalize, "C-c C-k": captureKill },
});
