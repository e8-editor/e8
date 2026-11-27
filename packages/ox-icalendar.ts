// Org's iCalendar export backend, after ox-icalendar.el: the ASCII
// backend's derivative that makes a calendar of RFC 5545 from an Org
// document, a VEVENT for each deadline, scheduled date and timestamp its
// options take, and a VTODO for each task, with repeaters as RRULEs,
// lines folded at 75 characters and ended with CRLF. Diary sexps
// (<%%(...)>) are Lisp, which E8 has none of (ADR 0116), so they are left
// out of the calendar.

import { type Datum, type Node, lineage, map, typeOf } from "org-element-ast";
import { normalizeString } from "org-element";
import { EXPORT_PARAMS } from "org-loaddefs";
import {
  type Info,
  baseFileName,
  data,
  defineDerivedBackend,
  exportAs,
  flag,
  getCategory,
  getNodeProperty,
  getPreviousElement,
  getTags,
  mapOpts,
  nonNil,
  outputFileName,
  stringAs,
  toFile,
  varValue,
} from "ox";
import { type Heading, agendaFiles as orgAgendaFiles, headingIndex, headings, propertyInheritP, selectiveGetter, today } from "org";
import { wdays } from "org-agenda";
import { orgIdGet, orgIdNew } from "org-id";
import { displayWarning, warn } from "warnings";

// The backend this one derives from, as ox-icalendar.el requires ox-ascii.
e8.require("ox-ascii");

const S = (name: string) => e8.intern(name);
const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });

// --- User-Configurable Variables -------------------------------------------------

defvar(
  "org-icalendar-combined-agenda-file",
  "~/org.ics",
  "The file name for the iCalendar file covering all agenda files, which org-icalendar-combine-agenda-files writes. It should be absolute; it is overwritten without warning.",
);
defvar(
  "org-icalendar-alarm-time",
  0,
  "Minutes before a timed event its alarm goes off: one alarm per entry, a DISPLAY action only. Zero, the default, makes no alarm.",
);
defvar(
  "org-icalendar-force-alarm",
  false,
  "Whether an alarm is made even when org-icalendar-alarm-time is zero, going off at the event's start.",
);
defvar("org-icalendar-combined-name", "OrgMode", "Calendar name for the combined iCalendar representing all agenda files.");
defvar("org-icalendar-combined-description", "", "Calendar description for the combined iCalendar (all agenda files).");
defvar(
  "org-icalendar-exclude-tags",
  [],
  "Tags that exclude a tree from iCalendar export, in place of other backends' exclude tags. The ICALENDAR_EXCLUDE_TAGS keyword sets them too.",
);
defvar("org-icalendar-scheduled-summary-prefix", "S: ", "String prepended to exported scheduled headlines.");
defvar("org-icalendar-deadline-summary-prefix", "DL: ", "String prepended to exported headlines with a deadline.");
defvar(
  "org-icalendar-use-deadline",
  [S("event-if-not-todo"), S("todo-due")],
  "Where iCalendar export uses a deadline, a list of: event-if-todo (deadlines in TODO entries become events), event-if-todo-not-done (in TODO entries not done), event-if-not-todo (in other entries), todo-due (deadlines in TODO entries are due dates).",
);
defvar(
  "org-icalendar-use-scheduled",
  [S("todo-start")],
  "Where iCalendar export uses a scheduled date, a list of: event-if-todo (scheduled TODO entries become events), event-if-todo-not-done (TODO entries not done), event-if-not-todo (other entries), todo-start (scheduled dates in TODO entries are start dates).",
);
defvar(
  "org-icalendar-categories",
  [S("local-tags"), S("category")],
  "What goes in the CATEGORIES field, a list of: category (the file's or tree's category), todo-state (the TODO keyword), local-tags (the heading's own tags), all-tags (inherited ones too).",
);
defvar(
  "org-icalendar-with-timestamps",
  S("active"),
  "Which plain timestamps become events: active, inactive, t for all or nil for none. Takes precedence over org-export-with-timestamps; #+OPTIONS: sets it as <:t.",
);
defvar(
  "org-icalendar-include-todo",
  false,
  "Which TODO items become VTODO components: nil none, t those not done, unblocked those not blocked, all every one, or a list of TODO keywords.",
);
defvar(
  "org-icalendar-todo-unscheduled-start",
  S("recurring-deadline-warning"),
  "The start date of a TODO with no scheduled date (when org-icalendar-use-scheduled has todo-start): recurring-deadline-warning, the deadline less its warning days when it repeats; deadline-warning, the same for any deadline; current-datetime, now; nil, none.",
);
defvar(
  "org-icalendar-include-bbdb-anniversaries",
  false,
  "Whether a combined iCalendar file includes BBDB's anniversaries; E8 has no BBDB, so none are.",
);
defvar(
  "org-icalendar-include-sexps",
  true,
  "Whether iCalendar export covers diary sexp entries; they are Lisp, which E8 does not evaluate, so they are left out either way.",
);
defvar(
  "org-icalendar-include-body",
  true,
  "How much of the text under a heading goes into its DESCRIPTION: nil nothing, t everything, or a number of characters at most. Properties, planning and clock lines are always left out.",
);
defvar(
  "org-icalendar-store-UID",
  false,
  "Whether the UIDs iCalendar export makes are stored in the entries' ID properties, so the next export gives each entry the same UID, as synchronization needs.",
);
defvar(
  "org-icalendar-timezone",
  e8.getenv("TZ") ?? null,
  "The time zone for iCalendar export, as TZ when E8 started; nil or empty for the one current-time-zone gives.",
);
defvar(
  "org-icalendar-date-time-format",
  ":%Y%m%dT%H%M%S",
  "Format of an iCalendar DATE-TIME, for format-time-string with org-icalendar-timezone as %Z: \":%Y%m%dT%H%M%S\" local time, \";TZID=%Z:%Y%m%dT%H%M%S\" local time with its zone, \":%Y%m%dT%H%M%SZ\" universal time.",
);
defvar(
  "org-icalendar-ttl",
  null,
  "Time to live of the exported calendar, as X-PUBLISHED-TTL, such as \"PT1H\" to reload it every hour; nil for none. The ICAL-TTL keyword sets it for a document.",
);
defvar(
  "org-icalendar-after-save-hook",
  [],
  "Functions run with the name of an iCalendar file once it has been saved, as to tell a calendar program to read it again.",
);
if (!e8.boundp("org-agenda-default-appointment-duration"))
  defvar(
    "org-agenda-default-appointment-duration",
    null,
    "Minutes an appointment with a start time and no end lasts, for iCalendar export's DTEND; nil for two hours.",
  );

// --- Internal Functions --------------------------------------------------------------

/** Whether a string has a character other than space, tab, CR and LF, as org-string-nw-p. */
const nw = (s: unknown): s is string => typeof s === "string" && /[^ \t\r\n]/.test(s);
const trim = (s: string) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A number at the start of a string, as string-to-number reads it: 0 for none. */
function stringToNumber(s: string): number {
  const m = /^[ \t\n]*([-+]?(?:[0-9]+(?:\.[0-9]*)?(?:e[-+]?[0-9]+)?|\.[0-9]+(?:e[-+]?[0-9]+)?))/i.exec(s);
  return m ? Number(m[1]) : 0;
}

/** A Lisp list variable's members, as names. */
function symbols(name: string): string[] {
  const v = varValue(name);
  return Array.isArray(v) ? v.map(String) : [];
}

/** A temporary buffer current while f runs, as with-temp-buffer. */
function withTempBuffer<T>(f: () => T): T {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, f);
  } finally {
    e8.call("kill-buffer", name);
  }
}

/** Whether a heading or any above it is commented, as org-in-commented-heading-p. */
function commentedHeadings(all: Heading[]): boolean[] {
  const stack: [number, boolean][] = [];
  return all.map((h) => {
    while (stack.length && stack[stack.length - 1][0] >= h.level) stack.pop();
    const own = /^COMMENT(?: |$)/.test(h.title);
    const commented = own || (stack.length > 0 && stack[stack.length - 1][1]);
    stack.push([h.level, commented]);
    return commented;
  });
}

/**
 * Sets an ID property on the headings missing one in the buffer, as
 * org-icalendar-create-uid: those outside commented trees, as
 * org-map-entries skips them. With BELL, says so when it changed the file.
 */
function createUid(file: string, bell: boolean): void {
  let modified = false;
  e8.saveExcursion(() => {
    // The headings in the accessible part, a heading under a COMMENT one
    // outside it commented too, as the element lineage reaches beyond a
    // narrowing. Markers at them, which the drawers added move.
    const all = e8.saveRestriction(() => (e8.widen(), headings()));
    const commented = commentedHeadings(all);
    const [min, max] = [e8.pointMin(), e8.pointMax()];
    const starts = all
      .map((h, i) => (commented[i] || h.start < min || h.start >= max ? undefined : e8.makeMarker(h.start)))
      .filter((m): m is e8.Marker => m !== undefined);
    try {
      for (const m of starts) {
        e8.gotoChar(e8.markerPosition(m)!);
        if (orgIdGet() === undefined) {
          orgIdGet(true);
          modified = true;
        }
      }
    } finally {
      for (const m of starts) e8.deleteMarker(m);
    }
  });
  if (bell && modified) {
    e8.message(`ID properties created in file "${file}"`);
    e8.sitFor(2);
  }
}

/**
 * Whether a heading is blocked, as org-icalendar-blocked-headline-p: a
 * child is not done, or a parent is ORDERED and a sibling before it is not
 * done, or the same holds of a parent with a TODO keyword.
 */
function blockedHeadlineP(headline: Node, info: Info): boolean {
  const childNotDone = map(headline.contents, "headline", (hl) => ((hl as Node).p["todo-type"] === "todo" ? true : undefined), mapOpts(info, { firstMatch: true }));
  if (childNotDone.length) return true;
  let current: Node = headline;
  for (const parent of lineage(headline)) {
    if (!parent.p["todo-keyword"]) return false;
    const ordered = parent.p.ORDERED;
    if (ordered !== undefined && ordered !== null && ordered !== "nil") {
      let sibling: Datum | undefined = current;
      while ((sibling = getPreviousElement(sibling, info)) !== undefined) {
        if (typeof sibling !== "string" && sibling.p["todo-type"] === "todo") return true;
      }
    } else current = parent;
  }
  return false;
}

/** Whether org-icalendar-date-time-format asks for UTC, ending with Z. */
function useUtcDateTimeP(): boolean {
  return String(varValue("org-icalendar-date-time-format")).endsWith("Z");
}

/**
 * A timestamp as an iCalendar line starting with KEYWORD, as
 * org-icalendar-convert-timestamp: its start, or with END its end, two
 * hours after the start (org-agenda-default-appointment-duration's minutes
 * if set) or the day after without one; TZ, "UTC" or a zone's name, says
 * the zone instead of org-icalendar-date-time-format.
 */
function convertTimestamp(ts: Node, keyword: string, end = false, tz?: string): string {
  const p = ts.p;
  const withTimeP = p["minute-start"] !== undefined && p["minute-start"] !== null;
  const start = [p["year-start"], p["month-start"], p["day-start"], p["hour-start"], p["minute-start"]];
  const stop = [p["year-end"], p["month-end"], p["day-end"], p["hour-end"], p["minute-end"]];
  const equalBoundsP = start.every((v, i) => (v ?? null) === (stop[i] ?? null));
  const duration = varValue("org-agenda-default-appointment-duration");
  const hasDuration = nonNil(duration);
  const mi = !withTimeP ? 0 : !end ? p["minute-start"] : hasDuration && equalBoundsP ? p["minute-end"] + Number(duration) : p["minute-end"];
  const h = !withTimeP ? 0 : !end ? p["hour-start"] : !equalBoundsP || hasDuration ? p["hour-end"] : p["hour-end"] + 2;
  const d = !end ? p["day-start"] : !withTimeP ? p["day-end"] + 1 : p["day-end"];
  const m = end ? p["month-end"] : p["month-start"];
  const y = end ? p["year-end"] : p["year-start"];
  let format: string;
  if (tz === "UTC") format = ":%Y%m%dT%H%M%SZ";
  else if (!withTimeP) format = ";VALUE=DATE:%Y%m%d";
  else if (typeof tz === "string") format = ";TZID=" + tz + ":%Y%m%dT%H%M%S";
  else {
    const fmt = String(varValue("org-icalendar-date-time-format"));
    if (fmt.includes("%Z")) {
      const zone = e8.variable("org-icalendar-timezone");
      if (typeof zone !== "string") e8.signal("wrong-type-argument", "Wrong type argument", [S("stringp"), zone ?? null]);
      format = fmt.split("%Z").join(zone as string);
    } else format = fmt;
  }
  // Through encode-time, which carries over a field past its range, as a minute of 60.
  const time = e8.encodeTime([0, mi, h, d, m, y]);
  const utc = tz === "UTC" || (tz === undefined && withTimeP && useUtcDateTimeP());
  return keyword + e8.formatTimeString(format, time, utc ? true : null);
}

/**
 * The DTSTAMP line, the time now in UTC, as org-icalendar-dtstamp; tests
 * that fix the day with e8--today stamp it with that day and time, written
 * as UTC, as the oracle's record.el stamps Emacs's.
 */
function dtstamp(): string {
  const fixed = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$/.exec(String(e8.variable("e8--today") ?? ""));
  if (fixed) return `DTSTAMP:${fixed[1]}${fixed[2]}${fixed[3]}T${pad(Number(fixed[4] ?? 12))}${pad(Number(fixed[5] ?? 0))}00Z`;
  return e8.formatTimeString("DTSTAMP:%Y%m%dT%H%M%SZ", null, true);
}

/** The CATEGORIES of an entry, as org-icalendar-categories lists them, each once, as org-icalendar-get-categories. */
function getCategories(entry: Node, info: Info): string {
  const out: string[] = [];
  for (const type of symbols("org-icalendar-categories")) {
    if (type === "category") out.push(getCategory(entry, info));
    else if (type === "todo-state") {
      if (entry.p["todo-keyword"]) out.push(entry.p["todo-keyword"]);
    } else if (type === "local-tags") out.push(...getTags(entry, info));
    else if (type === "all-tags") out.push(...getTags(entry, info, [], true));
  }
  return out.filter((c, i) => out.indexOf(c) === i).join(",");
}

/** A string as RFC 5545 writes text: backslash, comma and semicolon escaped, newlines as \n, as org-icalendar-cleanup-string. */
function cleanupString(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.replace(/[\\,;]/g, "\\$&").replace(/[ \t]*\n/g, "\\n");
}

/** A summary prefix cleaned up, nothing for nil, as concat takes a nil org-icalendar-cleanup-string gives. */
function summaryPrefix(prefix: unknown): string {
  return typeof prefix === "string" ? cleanupString(prefix)! : "";
}

/** A string split at newlines, one at either end dropped, as org-split-string. */
function splitLines(s: string): string[] {
  const parts = s.split("\n");
  if (parts.length > 1 && parts[0] === "") parts.shift();
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Lines longer than 75 characters folded, continued with a newline and a space, as org-icalendar-fold-string. */
function foldString(s: string): string {
  return normalizeString(
    splitLines(s)
      .map((line) => {
        const chars = [...line];
        if (chars.length <= 75) return line;
        // The marker takes a character of the continuation lines: 74 of the line's own on each.
        let folded = chars.slice(0, 75).join("");
        let chunk = 75;
        for (; chunk + 74 < chars.length; chunk += 74) folded += "\n " + chars.slice(chunk, chunk + 74).join("");
        return folded + "\n " + chars.slice(chunk).join("");
      })
      .join("\n"),
  );
}

/** Rewrite an exported iCalendar file with CRLF line ends, as RFC 5545 has them, then run org-icalendar-after-save-hook, as org-icalendar--post-process-file. */
function postProcessFile(file: string): undefined {
  withTempBuffer(() => {
    e8.insertFileContents(file);
    const used = e8.variable("last-coding-system-used");
    const coding = e8.codingSystemChangeEolConversion(typeof used === "string" ? used : "utf-8", "dos");
    e8.letBind({ "coding-system-for-write": coding }, () => e8.writeRegion(null, null, file));
  });
  e8.runHooks("org-icalendar-after-save-hook", file);
  return undefined;
}

// --- Filters ----------------------------------------------------------------------------

/** A transcoded heading without its blank lines, as org-icalendar-clear-blank-lines. */
function clearBlankLines(headline: string): string {
  // Lines start only after a newline, as Emacs's ^ has it, not after a CR.
  return headline.replace(/(?:^|(?<=\n))(?:[ \t]*\n)+/g, "");
}

// --- Transcode Functions ---------------------------------------------------------------

/** A property of an entry as org-entry-get reads it with 'selective inheritance, its values joined by newlines. */
function entryGet(entry: Node, name: string, info: Info): string | undefined {
  const getter = (info["icalendar--getter"] ??= selectiveGetter());
  const all: Heading[] = (info["icalendar--headings"] ??= e8.saveRestriction(() => (e8.widen(), headings())));
  const i = headingIndex(all, e8.lineOf(entry.p.begin));
  if (i === undefined) return undefined;
  return e8.letBind({ "org-property-separators": [[name, "\n"]] }, () => getter(all[i], name));
}

/** The data under an entry, as a document of its own: a heading's section, or an inline task's contents. */
function insideOf(entry: Node): Node | undefined {
  // As Org's (org-data nil . CONTENTS), the contents keeping their parents.
  if (entry.type === "inlinetask") return { type: "org-data", p: {}, contents: entry.contents };
  const first = entry.contents[0];
  return typeOf(first) === "section" ? { type: "org-data", p: {}, contents: (first as Node).contents } : undefined;
}

/** What an entry's components say of it, cleaned up as iCalendar's text. */
interface Fields {
  uid: string;
  summary: string;
  loc: string | undefined;
  desc: string | undefined;
  cat: string;
  tz: string | undefined;
  cls: string | undefined;
}

/**
 * An entry's UID, its ID or a new one, its summary (its SUMMARY or its
 * title), location, class, description (its DESCRIPTION or as much of its
 * text as org-icalendar-include-body says), categories and time zone, as
 * org-icalendar-entry works them out.
 */
function entryFields(entry: Node, inside: Node | undefined, info: Info): Fields {
  const uid: string = entry.p.ID ?? orgIdNew();
  const summary = cleanupString(entryGet(entry, "SUMMARY", info) ?? data(entry.p.title, info))!;
  const loc = cleanupString(entryGet(entry, "LOCATION", info));
  const classValue = getNodeProperty("CLASS", entry, propertyInheritP("CLASS"));
  const cls = cleanupString(typeof classValue === "string" ? classValue : undefined);
  const description = (() => {
    const own = entryGet(entry, "DESCRIPTION", info);
    if (own !== undefined) return own;
    const text = data(inside, info);
    if (!nw(text)) return undefined;
    const body = varValue("org-icalendar-include-body");
    if (typeof body === "number" && Number.isInteger(body) && body >= 0) {
      const chars = [...trim(text)];
      return chars.slice(0, Math.min(chars.length, body)).join("");
    }
    return nonNil(body) ? trim(text) : undefined;
  })();
  const desc = cleanupString(description);
  const cat = getCategories(entry, info);
  const tzValue = getNodeProperty("TIMEZONE", entry, propertyInheritP("TIMEZONE"));
  const tz = typeof tzValue === "string" ? tzValue : undefined;
  return { uid, summary, loc, desc, cat, tz, cls };
}

/**
 * A heading or inline task as iCalendar, as org-icalendar-entry: a VEVENT
 * for its deadline, its scheduled date and its timestamps, as the options
 * take them, a VTODO for a task, then its inline tasks' and the entries
 * below it, CONTENTS.
 */
function icalendarEntry(entry: Node, contents: string | undefined, info: Info): string | undefined {
  if (nonNil(entry.p["footnote-section-p"])) return undefined;
  const type = entry.type;
  const inside = insideOf(entry);
  const noRecursion = type === "headline" ? ["inlinetask"] : [];
  const todoType: string | undefined = entry.p["todo-type"];
  // What the components say of the entry, worked out once one is made, as
  // most headings make none: a new UID runs org-id-uuid-program.
  let fields: Fields | undefined;
  const f = (): Fields => (fields ??= entryFields(entry, inside, info));
  let out = "";
  // Events: from the deadline, the scheduled date and the timestamps.
  const eventFor = (ts: Node | undefined, use: string[]): boolean =>
    ts !== undefined &&
    (todoType === "todo" ? use.includes("event-if-todo-not-done") || use.includes("event-if-todo") : todoType === "done" ? use.includes("event-if-todo") : use.includes("event-if-not-todo"));
  const deadline: Node | undefined = entry.p.deadline;
  if (eventFor(deadline, toList(info["icalendar-use-deadline"]))) {
    const { uid, summary, loc, desc, cat, tz, cls } = f();
    out += vevent(entry, deadline!, "DL-" + uid, summaryPrefix(info["icalendar-deadline-summary-prefix"]) + summary, loc, desc, cat, tz, cls);
  }
  const scheduled: Node | undefined = entry.p.scheduled;
  if (eventFor(scheduled, toList(info["icalendar-use-scheduled"]))) {
    const { uid, summary, loc, desc, cat, tz, cls } = f();
    out += vevent(entry, scheduled!, "SC-" + uid, summaryPrefix(info["icalendar-scheduled-summary-prefix"]) + summary, loc, desc, cat, tz, cls);
  }
  // Timestamps in the title and the entry's own text; an inline task's are its own.
  let counter = 0;
  out += map(
    [entry.p.title ?? [], ...(inside?.contents ?? [])],
    "timestamp",
    (d) => {
      const ts = d as Node;
      const t = ts.p.type;
      const w = info["with-timestamps"];
      const wanted = w === "active" ? t === "active" || t === "active-range" : w === "inactive" ? t === "inactive" || t === "inactive-range" : w === true;
      if (!wanted) return undefined;
      const { uid, summary, loc, desc, cat, tz, cls } = f();
      return vevent(entry, ts, `TS${++counter}-${uid}`, summary, loc, desc, cat, tz, cls);
    },
    mapOpts(info, { noRecursion }),
  ).join("");
  // A task, when org-icalendar-include-todo takes it.
  if (todoType) {
    const include = info["icalendar-include-todo"];
    const wanted =
      include === "all"
        ? true
        : include === "unblocked"
          ? type === "headline" && !blockedHeadlineP(entry, info)
          : include === true
            ? todoType === "todo"
            : Array.isArray(include) && include.map(String).includes(entry.p["todo-keyword"]);
    if (wanted) {
      const { uid, summary, loc, desc, cat, tz, cls } = f();
      out += vtodo(entry, uid, summary, loc, desc, cat, tz, cls);
    }
  }
  // Diary sexps are Lisp, which E8 does not evaluate: none are transcoded.
  // A heading's inline tasks, each an entry of its own.
  if (type === "headline" && inside) out += map(inside, "inlinetask", (task) => icalendarEntry(task as Node, undefined, info) ?? "", mapOpts(info)).join("");
  return out + (contents ?? "");
}

/** An option's list of symbols, as names. */
function toList(v: any): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** An RRULE line for a repeater's unit and value, as org-icalendar--rrule. */
function rrule(unit: string, value: number): string {
  const freq = ({ hour: "HOURLY", day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" } as { [u: string]: string })[unit];
  return `RRULE:FREQ=${freq};INTERVAL=${Math.trunc(value)}`;
}

/** A VEVENT component, as org-icalendar--vevent; a diary sexp's makes none. */
function vevent(
  entry: Node,
  timestamp: Node,
  uid: string,
  summary: string,
  location: string | undefined,
  description: string | undefined,
  categories: string,
  timezone: string | undefined,
  cls: string | undefined,
): string {
  // Diary sexps are Lisp, which E8 does not evaluate.
  if (timestamp.p.type === "diary") return "";
  return (
    "BEGIN:VEVENT\n" +
    dtstamp() +
    "\n" +
    "UID:" +
    uid +
    "\n" +
    convertTimestamp(timestamp, "DTSTART", false, timezone) +
    "\n" +
    convertTimestamp(timestamp, "DTEND", true, timezone) +
    "\n" +
    (timestamp.p["repeater-type"] ? rrule(timestamp.p["repeater-unit"], timestamp.p["repeater-value"]) + "\n" : "") +
    "SUMMARY:" +
    summary +
    "\n" +
    (nw(location) ? `LOCATION:${location}\n` : "") +
    (nw(cls) ? `CLASS:${cls}\n` : "") +
    (nw(description) ? `DESCRIPTION:${description}\n` : "") +
    "CATEGORIES:" +
    categories +
    "\n" +
    (valarm(entry, timestamp, summary) ?? "") +
    "END:VEVENT\n"
  );
}

/** A display warning of type org, as org-display-warning. */
function orgDisplayWarning(message: string): void {
  displayWarning(S("org"), message);
}

/** A timestamp's repeater type if iCalendar export supports it, a cumulative one; warns of another, as org-icalendar--repeater-type. */
function repeaterType(ts: Node | undefined): string | undefined {
  const value = ts?.p["repeater-value"];
  const type: string | undefined = ts?.p["repeater-type"];
  if (!(type && value && value > 0)) return undefined;
  if (type !== "cumulate") {
    orgDisplayWarning(`Repeater-type ${type} not currently supported by iCalendar export`);
    return undefined;
  }
  return type;
}

/** A date with its fields carried over, as encode-time does: the 0th is the day before the 1st. */
function shiftDays(year: number, month: number, day: number, days: number): [number, number, number] {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(year, month - 1, day + days);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** A VTODO component, as org-icalendar--vtodo. */
function vtodo(
  entry: Node,
  uid: string,
  summary: string,
  location: string | undefined,
  description: string | undefined,
  categories: string,
  timezone: string | undefined,
  cls: string | undefined,
): string {
  const useScheduled = symbols("org-icalendar-use-scheduled");
  const useDeadline = symbols("org-icalendar-use-deadline");
  const sc: Node | undefined = useScheduled.includes("todo-start") ? entry.p.scheduled : undefined;
  const dl: Node | undefined = useDeadline.includes("todo-due") ? entry.p.deadline : undefined;
  const scRepeatP = repeaterType(sc);
  const dlRepeatP = repeaterType(dl);
  const repeatValue = sc?.p["repeater-value"] ?? dl?.p["repeater-value"];
  const repeatUnit = sc?.p["repeater-unit"] ?? dl?.p["repeater-unit"];
  const repeatUntil = scRepeatP && !dlRepeatP ? dl : undefined;
  const unscheduled = varValue("org-icalendar-todo-unscheduled-start");
  let start: Node | undefined;
  if (sc) start = sc;
  else if (unscheduled === "current-datetime") {
    const now = today(true);
    start = { type: "timestamp", p: { type: "active", "minute-start": now.minute, "hour-start": now.hour, "day-start": now.day, "month-start": now.month, "year-start": now.year }, contents: [] };
  } else if ((unscheduled === "deadline-warning" && dl) || (unscheduled === "recurring-deadline-warning" && dlRepeatP)) {
    // The deadline less its warning days, as org-timestamp-down-day moves it.
    const p = dl!.p;
    const [y, m, d] = shiftDays(p["year-start"], p["month-start"], p["day-start"], -wdays(p["raw-value"], false));
    start = { type: "timestamp", p: { ...p, "year-start": y, "month-start": m, "day-start": d, "year-end": y, "month-end": m, "day-end": d }, contents: [] };
  }
  let rule = "";
  if (dlRepeatP && !(repeatValue === dl!.p["repeater-value"] && repeatUnit === dl!.p["repeater-unit"])) {
    orgDisplayWarning("Not yet implemented: different repeaters on SCHEDULED and DEADLINE.  Skipping.");
  } else if (dlRepeatP && sc && !scRepeatP) {
    orgDisplayWarning("Not yet implemented: repeater on DEADLINE but not SCHEDULED.  Skipping.");
  } else if (scRepeatP || dlRepeatP) {
    rule = rrule(repeatUnit, repeatValue);
    if (repeatUntil) {
      const startTime = start!.p["minute-start"];
      // RFC 5545 has UNTIL in UTC unless DTSTART is in local time.
      const localTimeP = !timezone && varValue("org-icalendar-date-time-format") === ":%Y%m%dT%H%M%S";
      const u = repeatUntil.p;
      const encoded = e8.encodeTime([0, u["minute-start"] ?? 0, u["hour-start"] ?? 0, u["day-start"], u["month-start"], u["year-start"]]);
      rule +=
        ";UNTIL=" +
        (startTime === undefined || startTime === null
          ? e8.formatTimeString("%Y%m%d", encoded)
          : localTimeP
            ? e8.formatTimeString("%Y%m%dT%H%M%S", encoded)
            : e8.formatTimeString("%Y%m%dT%H%M%SZ", encoded, true));
    }
    rule += "\n";
  }
  const lowest = priorityValue("org-priority-lowest", "C");
  const highest = priorityValue("org-priority-highest", "A");
  const pri: number = entry.p.priority ?? priorityValue("org-priority-default", "B");
  return (
    "BEGIN:VTODO\n" +
    "UID:TODO-" +
    uid +
    "\n" +
    dtstamp() +
    "\n" +
    (start ? convertTimestamp(start, "DTSTART", false, timezone) + "\n" : "") +
    (dl && !repeatUntil ? convertTimestamp(dl, "DUE", false, timezone) + "\n" : "") +
    rule +
    "SUMMARY:" +
    summary +
    "\n" +
    (nw(location) ? `LOCATION:${location}\n` : "") +
    (nw(cls) ? `CLASS:${cls}\n` : "") +
    (nw(description) ? `DESCRIPTION:${description}\n` : "") +
    "CATEGORIES:" +
    categories +
    "\n" +
    "SEQUENCE:1\n" +
    `PRIORITY:${Math.floor(9 - 8 * ((lowest - pri) / (lowest - highest)))}\n` +
    `STATUS:${entry.p["todo-type"] === "todo" ? "NEEDS-ACTION" : "COMPLETED"}\n` +
    "END:VTODO\n"
  );
}

/** A priority variable's value as a character code, as Org keeps them. */
function priorityValue(name: string, fallback: string): number {
  const v = e8.variable(name) ?? fallback;
  return typeof v === "number" ? v : String(v || fallback).codePointAt(0)!;
}

/**
 * A VALARM component for a timed event, as org-icalendar--valarm: the
 * entry's APPT_WARNTIME minutes before, else org-icalendar-alarm-time's,
 * when either is positive or org-icalendar-force-alarm is on.
 */
function valarm(entry: Node, timestamp: Node, summary: string): string | undefined {
  const warntime = entry.p.APPT_WARNTIME;
  const alarmTime = typeof warntime === "string" ? stringToNumber(warntime) : undefined;
  const global = Number(varValue("org-icalendar-alarm-time") || 0);
  const force = nonNil(varValue("org-icalendar-force-alarm"));
  if (!((alarmTime !== undefined && alarmTime > 0) || global > 0 || force)) return undefined;
  if (timestamp.p["hour-start"] === undefined || timestamp.p["hour-start"] === null) return undefined;
  const minutes = alarmTime !== undefined && force ? alarmTime : alarmTime !== undefined && alarmTime !== 0 ? alarmTime : global;
  return `BEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:${summary}\nTRIGGER:-P0DT0H${Math.trunc(minutes)}M0S\nEND:VALARM\n`;
}

// --- Template ----------------------------------------------------------------------------

/** The calendar around the transcoded entries, as org-icalendar-template. */
function template(contents: string, info: Info): string {
  const input: string | undefined = info["input-file"];
  // Without a file, Org names it after the buffer it exports from, which is
  // its copy of the buffer, named as generate-new-buffer names a buffer of
  // the original's name: "notes<2>" for "notes". E8's copy has a name of its
  // own, so the name is made as Org's copy would have it.
  const name = input ? e8.fileNameNondirectory(input).replace(/\.[^.]*$/, "") : e8.generateNewBufferName(String(info["input-buffer"]));
  const owner = nonNil(info["with-author"]) ? data(info["author"], info) : "";
  return vcalendar(name, owner, timezoneName(), data(info["title"], info), info["icalendar-ttl"], contents);
}

/** The time zone the calendar says it is in: org-icalendar-timezone, else the current one's name. */
function timezoneName(): string {
  const tz = e8.variable("org-icalendar-timezone");
  return nw(tz) ? tz : e8.formatTimeString("%Z");
}

/**
 * A VCALENDAR component of a name, an owner, a time zone, a description,
 * a time to live and the components, folded, as org-icalendar--vcalendar:
 * one that is nil is written "nil", as format's %s writes it.
 */
function vcalendar(name: string | undefined, owner: string | undefined, tz: string, description: string | undefined, ttl: unknown, contents: string): string {
  const s = (v: string | undefined) => cleanupString(v) ?? "nil";
  return foldString(
    "BEGIN:VCALENDAR\n" +
      "VERSION:2.0\n" +
      `X-WR-CALNAME:${s(name)}\n` +
      `PRODID:-//${s(owner)}//Emacs with Org mode//EN\n` +
      `X-WR-TIMEZONE:${s(tz)}\n` +
      `X-WR-CALDESC:${s(description)}\n` +
      (nonNil(ttl) && typeof ttl === "string" ? `X-PUBLISHED-TTL:${cleanupString(ttl)}\n` : "") +
      "CALSCALE:GREGORIAN\n" +
      contents +
      "END:VCALENDAR\n",
  );
}

// --- Define Backend ------------------------------------------------------------------

defineDerivedBackend("icalendar", "ascii", {
  translate: {
    clock: null,
    "footnote-definition": null,
    "footnote-reference": null,
    headline: icalendarEntry,
    "inner-template": (contents: string) => contents,
    inlinetask: null,
    planning: null,
    section: null,
    template,
  } as any,
  options: [
    ["exclude-tags", "ICALENDAR_EXCLUDE_TAGS", undefined, "org-icalendar-exclude-tags", "split"],
    ["with-timestamps", undefined, "<", "org-icalendar-with-timestamps"],
    ["icalendar-alarm-time", undefined, undefined, "org-icalendar-alarm-time"],
    ["icalendar-categories", undefined, undefined, "org-icalendar-categories"],
    ["icalendar-date-time-format", undefined, undefined, "org-icalendar-date-time-format"],
    ["icalendar-include-bbdb-anniversaries", undefined, undefined, "org-icalendar-include-bbdb-anniversaries"],
    ["icalendar-include-body", undefined, undefined, "org-icalendar-include-body"],
    ["icalendar-include-sexps", undefined, undefined, "org-icalendar-include-sexps"],
    ["icalendar-include-todo", undefined, undefined, "org-icalendar-include-todo"],
    ["icalendar-store-UID", undefined, undefined, "org-icalendar-store-UID"],
    ["icalendar-timezone", undefined, undefined, "org-icalendar-timezone"],
    ["icalendar-use-deadline", undefined, undefined, "org-icalendar-use-deadline"],
    ["icalendar-use-scheduled", undefined, undefined, "org-icalendar-use-scheduled"],
    ["icalendar-scheduled-summary-prefix", undefined, undefined, "org-icalendar-scheduled-summary-prefix"],
    ["icalendar-deadline-summary-prefix", undefined, undefined, "org-icalendar-deadline-summary-prefix"],
    ["icalendar-ttl", "ICAL-TTL", undefined, "org-icalendar-ttl"],
  ],
  filters: { "filter-headline": (headline: string) => clearBlankLines(headline) },
  menu: [
    "c",
    "Export to iCalendar",
    [
      ["f", "Current file", (a: boolean, s: boolean, v: boolean, b: boolean) => exportToIcs(a, s, v, b)],
      ["a", "All agenda files", (a: boolean) => exportAgendaFiles(a)],
      ["c", "Combine all agenda files", (a: boolean) => combineAgendaFiles(a)],
    ],
  ],
});

// --- Interactive Functions -----------------------------------------------------------

/** What the exports give the ASCII backend: UTF-8, and links' destinations where they are, not in notes. */
const ASCII_OPTIONS: Info = { "ascii-charset": "utf-8", "ascii-links-to-notes": false };

/** Export the buffer, or its region or subtree, to an iCalendar file beside it, as org-icalendar-export-to-ics; returns the file's name. */
export function exportToIcs(_async?: unknown, subtreep?: unknown, visibleOnly?: unknown, bodyOnly?: unknown): string {
  const file = baseFileName();
  if (file && nonNil(varValue("org-icalendar-store-UID"))) createUid(file, true);
  const outfile = outputFileName(".ics", flag(subtreep));
  return toFile("icalendar", outfile, flag(subtreep), flag(visibleOnly), flag(bodyOnly), ASCII_OPTIONS, postProcessFile);
}

/**
 * Make sure an agenda file exists; if not, ask whether to remove it from
 * org-agenda-files, returning false to go on to the next, or to abort, as
 * org-check-agenda-file.
 */
function checkAgendaFile(file: string): boolean {
  if (e8.fileExistsP(file)) return true;
  e8.message(`Non-existent agenda file ${e8.abbreviateFileName(file)}.  [R]emove from list or [A]bort?`);
  const r = e8.readCharExclusive().toLowerCase();
  if (r !== "r") e8.userError("Abort");
  const files = e8.variable("org-agenda-files");
  if (Array.isArray(files)) {
    const truename = e8.fileTruename(file);
    e8.setVariable("org-agenda-files", files.filter((f) => typeof f !== "string" || e8.fileTruename(e8.expandFileName(f)) !== truename));
  }
  e8.message(`Removed from Org Agenda list: ${e8.abbreviateFileName(file)}`);
  return false;
}

/**
 * Run F in each agenda file's buffer, visiting those not open and killing
 * them after, asking to save one F changed, as the agenda's
 * org-get-agenda-file-buffer and org-release-buffers do.
 */
function inAgendaFiles<T>(f: (file: string) => T): T[] {
  const opened: string[] = [];
  try {
    const out: T[] = [];
    for (const file of agendaFiles()) {
      if (!checkAgendaFile(file)) continue;
      const before = e8.getFileBuffer(file);
      const buffer = before?.name ?? e8.findFileNoselect(file);
      if (!before) opened.push(buffer);
      out.push(e8.withCurrentBuffer(buffer, () => f(file)));
    }
    return out;
  } finally {
    for (const buffer of opened) {
      if (!e8.getBuffer(buffer)) continue;
      const file = e8.withCurrentBuffer(buffer, () => e8.bufferFileName());
      if (e8.bufferModifiedP(buffer) && file && e8.yOrNP(`Save file ${file}? `)) e8.withCurrentBuffer(buffer, () => e8.call("save-buffer"));
      e8.call("kill-buffer", buffer);
    }
  }
}

/** The agenda files, as (org-agenda-files t) lists them. */
function agendaFiles(): string[] {
  return orgAgendaFiles();
}

/** Export each agenda file to an iCalendar file beside it, as org-icalendar-export-agenda-files. */
export function exportAgendaFiles(_async?: unknown): void {
  inAgendaFiles((file) => {
    try {
      exportToIcs();
    } catch (err) {
      warn("Exporting %s to icalendar failed: %s", file, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

/** Combine every agenda file's entries into the one calendar org-icalendar-combined-agenda-file names, as org-icalendar-combine-agenda-files. */
export function combineAgendaFiles(_async?: unknown): void {
  combineFiles(agendaFiles());
}

/**
 * The text of each entry the current buffer's agenda text points to with
 * org-hd-marker, once each, from its heading to the next heading, as
 * org-icalendar-export-current-agenda collects them: from the first change
 * of the property after the buffer's start.
 */
function agendaEntryTexts(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let p = e8.nextSinglePropertyChange(e8.pointMin(), "org-hd-marker"); p !== undefined; p = e8.nextSinglePropertyChange(p, "org-hd-marker")) {
    const m = e8.getTextProperty(p, "org-hd-marker") as e8.Marker | undefined;
    const buffer = m ? e8.markerBuffer(m) : undefined;
    const at = m ? e8.markerPosition(m) : undefined;
    if (buffer === undefined || at === undefined) continue;
    const key = `${buffer}\u0000${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      e8.withCurrentBuffer(buffer, () =>
        e8.saveRestriction(() => {
          e8.widen();
          // To the next heading, as org-entry-end-position.
          const next = headings().find((h) => h.start > at);
          return e8.bufferText(at, next ? next.start : e8.pointMax());
        }),
      ),
    );
  }
  return out;
}

/** Export the current agenda view's entries to an iCalendar FILE, as org-icalendar-export-current-agenda. */
export function exportCurrentAgenda(file: string): void {
  const text = agendaEntryTexts()
    .map((t) => normalizeString(t))
    .join("");
  // Babel blocks are not run.
  const contents = e8.letBind({ "org-export-use-babel": false }, () =>
    stringAs(text, "icalendar", true, { ...ASCII_OPTIONS, "icalendar-include-todo": "all" }),
  );
  writeCalendar(file, contents);
}

/** A variable's string, or undefined for nil. */
function stringOrNil(v: e8.Value | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Write a calendar of the combined name, owner, zone, description and time to live around CONTENTS to FILE, then post-process it. */
function writeCalendar(file: string, contents: string): void {
  const out = vcalendar(
    stringOrNil(e8.variable("org-icalendar-combined-name")),
    stringOrNil(e8.variable("user-full-name")),
    timezoneName(),
    stringOrNil(e8.variable("org-icalendar-combined-description")),
    e8.variable("org-icalendar-ttl"),
    contents,
  );
  withTempBuffer(() => {
    e8.insert(out);
    e8.writeRegion(null, null, file);
  });
  postProcessFile(file);
}

/** Combine the entries of FILES into the iCalendar file org-icalendar-combined-agenda-file names, as org-icalendar--combine-files. */
function combineFiles(files: string[]): void {
  const target = String(varValue("org-icalendar-combined-agenda-file"));
  const opened: string[] = [];
  try {
    const parts: string[] = [];
    for (const file of files) {
      if (!checkAgendaFile(file)) continue;
      const before = e8.getFileBuffer(file);
      const buffer = before?.name ?? e8.findFileNoselect(file);
      if (!before) opened.push(buffer);
      parts.push(
        e8.withCurrentBuffer(buffer, () => {
          // An ID made where there is none, if UIDs are stored.
          if (nonNil(varValue("org-icalendar-store-UID"))) createUid(file, true);
          return exportAs("icalendar", false, false, true, ASCII_OPTIONS);
        }),
      );
    }
    writeCalendar(target, parts.join(""));
  } finally {
    for (const buffer of opened) {
      if (!e8.getBuffer(buffer)) continue;
      const file = e8.withCurrentBuffer(buffer, () => e8.bufferFileName());
      if (e8.bufferModifiedP(buffer) && file && e8.yOrNP(`Save file ${file}? `)) e8.withCurrentBuffer(buffer, () => e8.call("save-buffer"));
      e8.call("kill-buffer", buffer);
    }
  }
}

e8.defineCommand({
  name: "org-icalendar-export-to-ics",
  doc: "Export current buffer to an iCalendar file, named after the buffer's file with .ics; return its name.\n\nWith SUBTREEP, export the subtree at point; with VISIBLE-ONLY, only visible text; with BODY-ONLY, only what goes between BEGIN:VCALENDAR and END:VCALENDAR.",
  params: EXPORT_PARAMS,
  run: (a, s, v, b) => {
    exportToIcs(a, s, v, b);
  },
});

e8.defineCommand({
  name: "org-icalendar-export-agenda-files",
  doc: "Export all agenda files to iCalendar files, each beside its Org file.",
  params: [{ name: "async", kind: "prefix" }],
  run: (a) => exportAgendaFiles(a),
});

e8.defineCommand({
  name: "org-icalendar-combine-agenda-files",
  doc: "Combine all agenda files into a single iCalendar file, the one org-icalendar-combined-agenda-file names.",
  params: [{ name: "async", kind: "prefix" }],
  run: (a) => combineAgendaFiles(a),
});

e8.defun("org-icalendar-export-current-agenda", (file: string) => exportCurrentAgenda(file));
