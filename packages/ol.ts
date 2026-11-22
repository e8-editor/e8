// Links, after ol.el: the link point is on, where an internal link's
// target is in the buffer, for org-open-at-point to follow, and storing
// links to places, as org-store-link does, for org-insert-link to insert.

import { filenameAt } from "dired";
import { fileRelativeName } from "files";
import { ANGLE_LINK, at, COOKIE, entryEnd, type Heading, headingIndex, headings, LINK, linkTypeEntries, PLAIN_LINK, plistGet } from "org";
import { AFFILIATED, elementAt } from "org-element";
import { flag, folded } from "org-fold";
import { entryGet } from "org-list";
import { lineAt } from "org-macs";
import { allMatches, regexpQuote, truthy } from "subr";

export interface Link {
  start: number;
  end: number;
  path: string;
  description?: string;
  /** Which of Org's link syntaxes it is written in. */
  kind: "bracket" | "angle" | "plain";
}

/** The link point is on: a bracket link, an angle link or a plain one. */
export function linkHere(): Link | undefined {
  const line = lineAt();
  const text = e8.lineText(line);
  const p = e8.point();
  for (const m of allMatches(LINK, text)) {
    const start = at(line, text, m.index ?? 0);
    const end = at(line, text, (m.index ?? 0) + m[0].length);
    if (start <= p && p < end) return { start, end, path: m[1].replace(/\\([[\]\\])/g, "$1"), description: m[2], kind: "bracket" };
  }
  for (const re of [ANGLE_LINK, PLAIN_LINK]) {
    for (const m of allMatches(re, text)) {
      const start = at(line, text, m.index ?? 0);
      const end = at(line, text, (m.index ?? 0) + m[0].length);
      if (start <= p && p < end) return { start, end, path: m[0].replace(/^<|>$/g, ""), kind: re === ANGLE_LINK ? "angle" : "plain" };
    }
  }
  return undefined;
}

/** The title Org matches a heading link against: without its state, priority, cookies or tags. */
function bareTitle(h: Heading): string {
  return h.title.replace(new RegExp(COOKIE.source, "g"), "").replace(/\s+/g, " ").trim();
}

function searchHeading(title: string): Heading | undefined {
  // Case does not matter, as org-link-search compares the words upcased.
  const want = title.replace(/\s+/g, " ").trim().toUpperCase();
  return headings().find((h) => bareTitle(h).toUpperCase() === want);
}

/** Follows a link within the buffer: *Heading, #custom-id, a <<target>> or a heading's title. */
export function searchInBuffer(path: string): number {
  if (path.startsWith("*")) {
    const h = searchHeading(path.slice(1));
    if (!h) throw new Error(`No match for fuzzy expression: ${path}`);
    return h.start;
  }
  if (path.startsWith("#")) {
    const id = path.slice(1);
    const found = e8.search(`^[ \\t]*:CUSTOM_ID:[ \\t]+${regexpQuote(id)}[ \\t]*$`, { from: 0, regexp: true });
    if (!found) throw new Error(`No match for custom ID: ${id}`);
    const all = headings();
    const i = headingIndex(all, lineAt(found.start));
    return i === undefined ? found.start : all[i].start;
  }
  if (/^\d+$/.test(path)) return e8.lineStart(Math.min(Number(path) - 1, e8.lineCount() - 1));
  const target = e8.search(`<<${path}>>`, { from: 0 });
  if (target) return target.start;
  // Headings only in Org buffers; elsewhere, as in a program a link of
  // %a's names, the words anywhere, as org-link-search's free text search.
  const h = e8.derivedModeP("org-mode") ? searchHeading(path) : undefined;
  if (h) return h.start;
  const words = path.trim().split(/\s+/).map(regexpQuote).join("[ \t\r\n]+");
  const text = !e8.derivedModeP("org-mode") && words !== "" ? e8.search(words, { from: 0, regexp: true, caseFold: true }) : undefined;
  if (text) return text.start;
  throw new Error(`No match for fuzzy expression: ${path}`);
}

export function jump(pos: number): void {
  e8.pushMark(e8.point());
  e8.gotoChar(pos);
  showContext(pos);
}

/** Shows the headings above a position if it is folded away, as org-fold-show-context does. */
export function showContext(pos: number): void {
  const all = headings();
  const i = headingIndex(all, lineAt(pos));
  if (i !== undefined && folded(Math.max(0, all[i].start - 1), "outline")) {
    for (const h of all.slice(0, i + 1)) {
      if (h.start <= pos) flag(h.end, entryEnd(all, all.indexOf(h)), false);
    }
  }
}

// Storing links, as org-store-link does, and inserting them, as
// org-insert-link does.

e8.defineVariable({
  name: "org-stored-links",
  doc: "The links org-store-link has stored, newest first, each a list of the link and its description, or nil for none.",
  value: [],
});
e8.defineVariable({
  name: "org-store-link-plist",
  doc: "The properties of the link stored last, as a link type's store function gave them with org-link-store-props.",
  value: [],
});
e8.defineVariable({
  name: "org-link-context-for-files",
  doc: "Whether a file link org-store-link makes searches for where point is: the heading, a name, the active region or the line. A number takes that many lines of the region. C-u before org-store-link turns it round.",
  value: true,
});
e8.defineVariable({
  name: "org-link-keep-stored-after-insertion",
  doc: "Whether a stored link stays among org-stored-links once org-insert-link has inserted it.",
  value: false,
});
e8.defineVariable({
  name: "org-link-file-path-type",
  doc: 'How org-insert-link writes a file\'s name: "adaptive", relative to the current directory below it and abbreviated elsewhere; "relative"; "absolute", abbreviated; "noabbrev"; or a function of the name.',
  value: "adaptive",
});
e8.defineVariable({
  name: "org-link-make-description-function",
  doc: "A function of the link and the description so far giving the description org-insert-link offers, or nil.",
  value: null,
});
e8.defineVariable({ name: "org-link--history", doc: "History for inserted links.", value: [] });
e8.defineVariable({ name: "org-link--insert-history", doc: "Minibuffer history for links inserted with org-insert-link.", value: [] });
e8.defineHook(
  "org-create-file-search-functions",
  "Functions making a search string to point's place, for org-store-link's file link to this file: the first that gives one is used, and may set :description with org-link-store-props.",
);

type StoredLink = [string, string | null];

function storedLinks(): StoredLink[] {
  const v = e8.variable("org-stored-links");
  return Array.isArray(v) ? (v.filter((x) => Array.isArray(x) && typeof x[0] === "string") as StoredLink[]) : [];
}

/** A value read as Lisp reads a symbol's name, for options set as symbols. */
const nameOf = (v: e8.Value | undefined): e8.Value => (typeof v === "symbol" ? e8.symbolName(v) : (v ?? null));

/** Whether a prefix argument is C-u pressed N times, as (equal arg '(4^N)). */
const isPrefix = (arg: e8.Value | undefined, n: number): boolean => Array.isArray(arg) && arg.length === 1 && arg[0] === 4 ** n;

/** A link as Org writes one, its target's brackets escaped, as org-link-make-string. */
export function linkMakeString(link: string, description?: string | null): string {
  const desc = description != null && /\S/.test(description) ? description.trim().replace(/\]$/, "]​").replace(/(\])(\])/g, "$1​$2") : undefined;
  if (!/\S/.test(link)) {
    if (desc === undefined) e8.signal("error", "Empty link");
    return desc as string;
  }
  const escaped = link.replace(/(\\*)([\][]|$)/g, (_m, bs: string, c: string) => `${bs}${bs}${c === "" ? "" : "\\"}${c}`);
  return `[[${escaped}]${desc === undefined ? "" : `[${desc}]`}]`;
}
e8.defun("org-link-make-string", (link: e8.Value, description?: e8.Value) => linkMakeString(String(link), typeof description === "string" ? description : null));

/** Org's bracket link, its target in group 1 and description in 2, as org-link-bracket-re. */
const LINK_BRACKET = /\[\[((?:[^\][\\]|\\(?:\\\\)*[\][]|\\+[^\][])+)\](?:\[([\s\S]+?)\])?\]/g;

/** Links in a string shown as their descriptions, or targets without one, as org-link-display-format. */
export function linkDisplayFormat(s: string): string {
  return s.replace(LINK_BRACKET, (_m, target: string, desc?: string) => desc ?? target);
}

/**
 * A string without statistics cookies and with spaces packed, as
 * org-link--normalize-string; as a context, also without the search
 * syntax around it, parentheses or leading stars and hashes.
 */
function normalizeString(text: string, context = false): string {
  let s = text
    .replace(/\[[0-9]*(?:%|\/[0-9]*)\]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  if (context) {
    for (;;) {
      if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
      else if (/^[#*]+[ \t]*/.test(s)) s = s.replace(/^[#*]+[ \t]*/, "");
      else break;
    }
  }
  return s;
}

/** The active region's text, if any, to org-link-context-for-files's number of lines, as org-link--context-from-region. */
function contextFromRegion(): string | undefined {
  const mark = e8.mark();
  if (!e8.regionActive() || mark === undefined) return undefined;
  let context = e8.bufferSubstringNoProperties(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
  const n = e8.variable("org-link-context-for-files");
  if (typeof n === "number" && Number.isInteger(n) && n > 0) {
    // As org-split-string: lines, leaving out empty ones.
    context = context.split(/\n/).filter((l) => l !== "").slice(0, n).join("\n");
  }
  return context;
}

/** A heading's title as org-get-heading t t t t gives it: without state, priority, COMMENT or tags. */
const bareHeading = (h: Heading): string => h.title.replace(/^COMMENT(?:[ \t]+|$)/, "");

/** The search string for a heading, *Title, as org-link-heading-search-string. */
export function linkHeadingSearchString(title: string): string {
  return `*${normalizeString(title)}`;
}

/** The #+NAME: of the element at a position, if it has one, as org-element's :name. */
function elementName(pos: number): { name: string; begin: number } | undefined {
  // On the element's affiliated keywords, the element after them.
  let line = lineAt(pos);
  while (line + 1 < e8.lineCount() && AFFILIATED.test(e8.lineText(line))) line++;
  const e = elementAt(line === lineAt(pos) ? pos : e8.lineStart(line));
  if (!e || e.type === "headline") return undefined;
  let name: string | undefined;
  let begin = e.begin;
  for (let l = lineAt(e.begin) - 1; l >= 0 && AFFILIATED.test(e8.lineText(l)); l--) {
    begin = e8.lineStart(l);
    const m = /^[ \t]*#\+NAME:[ \t]*(.*?)[ \t]*$/i.exec(e8.lineText(l));
    if (m && name === undefined) name = m[1];
  }
  return name === undefined ? undefined : { name, begin };
}

/**
 * The search string and description for a link to point's place, and
 * where the search finds it, as org-link-precise-link-target: the active
 * region; in Org, a named element's name, the heading's #CUSTOM_ID or
 * *Title; else the line.
 */
export function linkPreciseTarget(): [string, string | null, number] | undefined {
  const region = contextFromRegion();
  let result: [string, string | null, number] | undefined;
  const lineString = () => e8.lineText(lineAt());
  if (region !== undefined) {
    const mark = e8.mark() as number;
    result = [normalizeString(region, true), null, Math.min(mark, e8.point())];
  } else if (e8.derivedModeP("org-mode")) {
    const named = elementName(e8.point());
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (named) result = [named.name, named.name, named.begin];
    else if (i === undefined) result = [normalizeString(lineString(), true), null, e8.lineStart(lineAt())];
    else {
      const h = all[i];
      const customId = entryGet(h.line, "CUSTOM_ID");
      result = [customId !== undefined ? `#${customId}` : linkHeadingSearchString(bareHeading(h)), normalizeString(bareHeading(h)), h.start];
    }
  } else result = [normalizeString(lineString(), true), null, e8.lineStart(lineAt())];
  return result && /\S/.test(result[0]) ? result : undefined;
}
e8.defun("org-link-precise-link-target", () => linkPreciseTarget() ?? null);

/** The file of the buffer, or of the one an indirect buffer shares its text with, as buffer-file-name of buffer-base-buffer. */
function baseFileName(): string | undefined {
  const base = e8.bufferBaseBuffer();
  return base ? e8.withCurrentBuffer(base, () => e8.bufferFileName()) : e8.bufferFileName();
}

/** A file link to here, with a search string to point's place, and its description, as org-link--file-link-to-here. */
function fileLinkToHere(): StoredLink {
  let link = `file:${e8.abbreviateFileName(baseFileName() as string)}`;
  let desc: string | null = null;
  if (truthy(e8.variable("org-link-context-for-files") ?? null)) {
    const target = linkPreciseTarget();
    if (target) {
      link = `${link}::${target[0]}`;
      desc = target[1];
    }
  }
  return [link, desc];
}

/** Sets the properties of the link being stored, as org-link-store-props: a property list, as [":type", "id", ":link", ...]. */
export function linkStoreProps(plist: e8.Value[]): void {
  e8.setVariable("org-store-link-plist", [...plist]);
}
e8.defun("org-link-store-props", (...plist: e8.Value[]) => linkStoreProps(plist));

/**
 * Tries the link types' store functions, as org-link--try-link-store-functions:
 * when more than one can, asks which; returns whether one stored a link.
 */
function tryLinkStoreFunctions(interactive: boolean): boolean {
  const results: [string, e8.Value][] = [];
  for (const [, params] of linkTypeEntries()) {
    if (!params.store) continue;
    if (truthy((params.store.run(interactive) as e8.Value) ?? null)) {
      const plist = e8.variable("org-store-link-plist");
      results.unshift([params.store.name, Array.isArray(plist) ? [...plist] : []]);
    }
  }
  if (results.length === 0) return false;
  if (results.length > 1) {
    const name = results[0][0];
    const chosen = e8.completingRead(
      `Store link with (default ${name}): `,
      results.map((r) => r[0]),
      { requireMatch: true, default: name },
    );
    linkStoreProps((results.find((r) => r[0] === chosen) ?? results[0])[1] as e8.Value[]);
  }
  return true;
}

/** Adds a link to org-stored-links, or moves it to the front, saying which, as org-link--add-to-stored-links. */
function addToStoredLinks(link: string, desc: string | null): void {
  const stored = storedLinks();
  const same = (x: StoredLink) => x[0] === link && x[1] === desc;
  if (!stored.some(same)) {
    e8.setVariable("org-stored-links", [[link, desc], ...stored]);
    e8.message(`Stored: ${desc ?? link}`);
  } else if (same(stored[0])) e8.message("This link has already been stored");
  else {
    e8.setVariable("org-stored-links", [[link, desc], ...stored.filter((x) => !same(x))]);
    e8.message(`Link moved to front: ${desc ?? link}`);
  }
}

/** The agenda's entry on the line at point, which org-agenda.ts tells: its buffer and the position its line points to. */
let agendaEntryHere: (() => { buffer: string; pos: number } | undefined) | undefined;
export function setAgendaEntryHere(f: () => { buffer: string; pos: number } | undefined): void {
  agendaEntryHere = f;
}

/**
 * Stores a link to point's place, as org-store-link does: with a link
 * type's store function, from the agenda, Dired or an image, with
 * org-create-file-search-functions, or in a file, to the heading, target
 * or line. Interactively it goes in org-stored-links, an Org entry's
 * CUSTOM_ID link too; otherwise it is returned as a bracket link. C-u
 * turns org-link-context-for-files round, C-u C-u leaves out the link
 * types' functions, and C-u C-u C-u with a region stores a link to each
 * of its lines.
 */
export function storeLink(arg: e8.Value | undefined, interactive: boolean): e8.Value {
  if (isPrefix(arg, 3) && e8.regionActive()) {
    const mark = e8.mark() as number;
    const end = Math.max(mark, e8.point());
    e8.saveExcursion(() => {
      e8.gotoChar(Math.min(mark, e8.point()));
      e8.setMark(e8.point());
      while (e8.lineEnd(lineAt()) < end) {
        e8.gotoChar(e8.lineEnd(lineAt()));
        e8.activateMark();
        storeLink(null, true);
        e8.gotoChar(Math.min(e8.lineEnd(lineAt()) + 1, e8.pointMax()));
        e8.setMark(e8.point());
      }
    });
    return null;
  }
  e8.setVariable("org-store-link-plist", []);
  const context = e8.variable("org-link-context-for-files") ?? null;
  const negate = isPrefix(arg, 1);
  // As org-xor: the value itself when not turned round.
  const xor = truthy(context) ? (negate ? null : context) : negate;
  return e8.letBind({ "org-link-context-for-files": xor }, () => {
    let link: string | undefined;
    let desc: string | null = null;
    let agendaLink: e8.Value | undefined;
    const mode = e8.variable("major-mode");
    if (!isPrefix(arg, 2) && tryLinkStoreFunctions(interactive)) {
      const plist = e8.variable("org-store-link-plist");
      const l = plistGet(plist, ":link");
      link = typeof l === "string" ? l : undefined;
      const d = plistGet(plist, ":description");
      desc = typeof d === "string" ? d : null;
    } else if (mode === "org-agenda-mode") {
      const entry = agendaEntryHere?.();
      if (entry !== undefined) {
        agendaLink = e8.withCurrentBuffer(entry.buffer, () =>
          e8.saveExcursion(() =>
            e8.saveRestriction(() => {
              e8.widen();
              e8.gotoChar(entry.pos);
              return storeLink(null, interactive);
            }),
          ),
        );
      }
    } else if (mode === "image-mode" && e8.bufferFileName() !== undefined) {
      const file = e8.bufferFileName() as string;
      link = `file:${e8.abbreviateFileName(file)}`;
      linkStoreProps([e8.intern(":type"), "image", e8.intern(":file"), file]);
    } else if (e8.derivedModeP("dired-mode")) {
      const file = filenameAt();
      link = `file:${typeof file === "string" ? e8.abbreviateFileName(e8.expandFileName(file)) : String(e8.variable("default-directory") ?? "")}`;
    } else {
      const search = e8.runHookWithArgsUntilSuccess("org-create-file-search-functions");
      if (typeof search === "string" && search !== "" && e8.bufferFileName() !== undefined) {
        link = `file:${e8.abbreviateFileName(e8.bufferFileName() as string)}::${search}`;
        const d = plistGet(e8.variable("org-store-link-plist"), ":description");
        desc = typeof d === "string" ? d : null;
      } else if (baseFileName() !== undefined && e8.derivedModeP("org-mode")) {
        // A <<target>> at point, else the heading, as Org does.
        const text = e8.lineText(lineAt());
        const col = e8.point() - e8.lineStart(lineAt());
        const chars = [...text];
        const target = allMatches(/(?:^|[^<])<<([^<>\n]+)>>(?:[^>]|$)/g, text).find((m) => {
          const from = [...text.slice(0, m.index ?? 0)].length;
          return from <= col && col <= from + [...m[0]].length;
        });
        if (target && chars.length >= 0) link = `file:${e8.abbreviateFileName(baseFileName() as string)}::${target[1]}`;
        else [link, desc] = fileLinkToHere();
      } else if (baseFileName() !== undefined) [link, desc] = fileLinkToHere();
      else if (interactive) e8.userError("No method for storing a link from this buffer");
    }
    if (desc === "NONE") desc = null;
    else if (desc !== null) desc = linkDisplayFormat(desc);
    if (!(interactive && link !== undefined)) return agendaLink ?? (link === undefined ? null : linkMakeString(link, desc));
    addToStoredLinks(link, desc);
    // In Org, a human-readable link by CUSTOM_ID too.
    if (baseFileName() !== undefined && e8.derivedModeP("org-mode")) {
      const all = headings();
      const i = headingIndex(all, lineAt());
      if (i !== undefined && entryGet(all[i].line, "CUSTOM_ID") !== undefined) {
        const [l, d] = fileLinkToHere();
        const first = storedLinks()[0];
        if (!(first && first[0] === l && first[1] === d)) addToStoredLinks(l, d);
      }
    }
    return storedLinks()[0] ?? null;
  });
}

e8.defineCommand({
  name: "org-store-link",
  doc:
    "Store a link to point's place, for org-insert-link (C-c C-l) to insert: in an Org file to the heading, a target or a named element, in another file to the line, in Dired to the file, in the agenda to the entry. " +
    "C-u turns org-link-context-for-files round, C-u C-u leaves out the link types' own ways of storing, and C-u C-u C-u stores a link to each line of the region.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.Value) => {
    storeLink(arg, e8.calledInteractively());
  },
});

/** The link types org-insert-link completes, as org-link-types: Org's own and those packages add. */
function linkPrefixes(): string[] {
  const own = ["file+sys", "file+emacs", "shell", "news", "mailto", "https", "http", "ftp", "help", "file", "elisp"];
  return [...new Set([...linkTypeEntries().map(([t]) => t), ...own])];
}

/** A file link read with completion, as org-link-complete-file: relative below the current directory, or with C-u C-u abbreviated. */
function linkCompleteFile(arg: e8.Value | undefined): string {
  const file = e8.readFileName("File: ");
  const pwd = e8.fileNameAsDirectory(e8.expandFileName("."));
  const pwd1 = e8.fileNameAsDirectory(e8.abbreviateFileName(e8.expandFileName(".")));
  if (isPrefix(arg, 2)) return `file:${e8.abbreviateFileName(e8.expandFileName(file))}`;
  if (file.startsWith(pwd1) && file.length > pwd1.length) return `file:${file.slice(pwd1.length)}`;
  const full = e8.expandFileName(file);
  if (full.startsWith(pwd) && full.length > pwd.length) return `file:${full.slice(pwd.length)}`;
  return `file:${file}`;
}

/** A link of TYPE read with the type's completion, or as text, as org-link--try-special-completion. */
function trySpecialCompletion(type: string): string {
  if (type === "file") return linkCompleteFile(null);
  const complete = linkTypeEntries().find(([t]) => t === type)?.[1].complete;
  return complete ? complete() : e8.readString("Link (no completion support): ", { initial: `${type}:` });
}

/** A stored link as *Org Links* lists it, its description padded, as org-link--prettify. */
function prettify(l: StoredLink): string {
  const desc = l[1] ?? "<no description>";
  return `${[...desc].slice(0, 40).join("").padEnd(45)}<${l[0]}>`;
}

/** Reads a link, showing the stored ones in *Org Links*, as org-insert-link does with no link at point. */
function readLink(): string {
  const stored = storedLinks();
  const config = e8.currentWindowConfiguration();
  const origin = e8.bufferName(e8.currentBuffer()) as string;
  const selected = e8.selectedWindow();
  e8.call("switch-to-buffer-other-window", "*Org Links*");
  e8.withCurrentBuffer("*Org Links*", () => {
    e8.setVariable("buffer-read-only", true);
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      let text = "Type TAB to complete link type, then RET to complete destination.\n";
      if (stored.length > 0) text += `\nStored links accessible with <up>/<down> or M-p/M-n are:\n\n${[...stored].reverse().map(prettify).join("\n")}`;
      e8.insert(text);
    });
    e8.gotoChar(e8.pointMin());
    e8.setVariable("truncate-lines", true);
  });
  e8.selectWindow(selected);
  let link: string;
  try {
    const history = [...stored.map((l) => l[0]), ...((e8.variable("org-link--insert-history") as string[]) ?? [])];
    const prefixes = linkPrefixes();
    link = e8.letBind({ "org-link--history": history }, () =>
      e8.completingRead(
        stored.length > 0 ? `Insert link (default ${stored[0][0]}): ` : "Insert link: ",
        [...prefixes.map((p) => `${p}:`), ...stored.map((l) => l[0]), ...stored.flatMap((l) => (l[1] === null ? [] : [l[1]]))],
        { history: "org-link--history", default: stored[0]?.[0] },
      ),
    );
    if (!/\S/.test(link)) e8.userError("No link selected");
    for (const l of stored) if (l[1] === link) link = l[0];
    const bare = link.endsWith(":") ? link.slice(0, -1) : undefined;
    if (prefixes.includes(link) || (bare !== undefined && prefixes.includes(bare))) {
      const type = bare !== undefined && prefixes.includes(bare) ? bare : link;
      link = e8.withCurrentBuffer(origin, () => trySpecialCompletion(type));
    }
  } finally {
    e8.setWindowConfiguration(config);
    if (e8.getBuffer("*Org Links*")) e8.call("kill-buffer", "*Org Links*");
  }
  return link;
}

/**
 * Inserts a link, as org-insert-link does: the one at point edited; with
 * C-u a file's, completed; else one read with completion, the stored ones
 * offered, the newest the default. A link to this file is written as its
 * search; a file's name as org-link-file-path-type says. The description
 * is the region's text, the stored link's, or what the type or
 * org-link-make-description-function offers, read interactively. The
 * link inserted leaves org-stored-links unless
 * org-link-keep-stored-after-insertion, which C-u C-u C-u turns round.
 */
export function insertLink(completeFile: e8.Value | undefined, linkLocation?: string, description?: string, interactive = false): void {
  const mark = e8.mark();
  const regionActive = e8.regionActive() && mark !== undefined;
  const region = regionActive ? e8.bufferSubstringNoProperties(Math.min(mark, e8.point()), Math.max(mark, e8.point())) : undefined;
  let remove: [number, number] | undefined = regionActive ? [Math.min(mark, e8.point()), Math.max(mark, e8.point())] : undefined;
  let desc: string | undefined = region;
  let link = linkLocation;
  if (link !== undefined) {
    // Given: used as it is.
  } else {
    const here = linkHere();
    if (here?.kind === "bracket") {
      remove = [here.start, here.end];
      desc = here.description;
      link = e8.readString("Link: ", { initial: here.path });
    } else if (here) {
      remove = [here.start, here.end];
      link = e8.readString("Link: ", { initial: here.path });
    } else if (isPrefix(completeFile, 1) || isPrefix(completeFile, 2)) link = linkCompleteFile(completeFile);
    else {
      link = readLink();
      const entry = storedLinks().find((l) => l[0] === link);
      if (!entry) e8.setVariable("org-link--insert-history", [link, ...((e8.variable("org-link--insert-history") as string[]) ?? [])]);
      desc = desc ?? entry?.[1] ?? undefined;
    }
  }
  const original = link;
  // A plain link, not a timestamp, without angle brackets.
  if (/^<?(?:https?|ftp|mailto|file|news|doi):/.test(link) && !/^<\d{4}-\d{2}-\d{2}/.test(link)) link = link.replace(/^<(.*)>$/, "$1");
  const file = baseFileName();
  const same = /^file:(.+?)::/.exec(link);
  if (file !== undefined && same && e8.fileTruename(file) === e8.fileTruename(e8.expandFileName(same[1]))) {
    // To this same file: its search alone.
    link = link.slice(same[0].length);
  }
  const typed = /^(file|docview):/.exec(link);
  if (typed) {
    const type = typed[0];
    const option = /::(.*)$/.exec(link);
    let path = option ? link.slice(type.length, option.index) : link.slice(type.length);
    const origPath = path;
    const how = nameOf(e8.variable("org-link-file-path-type"));
    if (how === "absolute" || isPrefix(completeFile, 2)) path = e8.abbreviateFileName(e8.expandFileName(path));
    else if (how === "noabbrev") path = e8.expandFileName(path);
    else if (how === "relative") path = fileRelativeName(path);
    else if (typeof how === "function" || (typeof how === "string" && how !== "adaptive" && e8.fboundp(how))) path = String(e8.funcall(how, path));
    else {
      const dir = e8.expandFileName(e8.fileNameAsDirectory(String(e8.variable("default-directory") ?? "")));
      const full = e8.expandFileName(path);
      path = full.startsWith(dir) ? full.slice(dir.length) : e8.abbreviateFileName(full);
    }
    link = `${type}${path}${option ? `::${option[1]}` : ""}`;
    if (desc === origPath) desc = path;
  }
  const prefixes = linkPrefixes();
  const typeMatch = new RegExp(`^(${prefixes.map(regexpQuote).join("|")}):`).exec(link);
  const type = typeMatch ? typeMatch[1] : link.startsWith("/") || link.startsWith("~") || /^\.\.?\//.test(link) ? "file" : undefined;
  let initial: string | undefined = description ?? desc;
  if (initial === undefined) {
    const insertDescription = type === undefined ? undefined : linkTypeEntries().find(([t]) => t === type)?.[1].insertDescription;
    const make = e8.variable("org-link-make-description-function");
    if (typeof insertDescription === "string") initial = insertDescription;
    else if (typeof insertDescription === "function") initial = insertDescription(link, desc);
    else if (truthy(make ?? null)) {
      try {
        const d = e8.funcall(make as string, link, desc ?? null);
        initial = typeof d === "string" ? d : undefined;
      } catch {
        e8.message(`Can't get link description from ${String(nameOf(make))}`);
      }
    }
  }
  desc = interactive ? e8.readString("Description: ", { initial: initial ?? "" }) : initial;
  const keep = truthy(e8.variable("org-link-keep-stored-after-insertion") ?? null);
  if (isPrefix(completeFile, 3) ? keep : !keep) {
    const stored = storedLinks();
    const at = stored.findIndex((l) => l[0] === original);
    if (at >= 0) e8.setVariable("org-stored-links", stored.filter((_, i) => i !== at));
  }
  if (desc !== undefined && !/\S/.test(desc)) desc = undefined;
  if (remove) {
    e8.deleteRegion(remove[0], remove[1]);
    e8.gotoChar(remove[0]);
    e8.deactivateMark();
  }
  e8.insert(linkMakeString(link, desc ?? null));
}

e8.defineCommand({
  name: "org-insert-link",
  doc:
    "Insert a link, offering the links org-store-link stored, the newest when the input is left empty, and asking for a description; on a link, edit it. " +
    "C-u completes a file's name, C-u C-u writing it absolute, and C-u C-u C-u keeps the stored link, as org-link-keep-stored-after-insertion turned round.",
  // Code can give the link and the description, first so that a call need
  // not give the prefix argument; interactively they are read.
  params: [
    { name: "link-location", value: () => "" },
    { name: "description", value: () => "" },
    { name: "complete-file", kind: "prefix" },
  ],
  run: (linkLocation: string, description: string, completeFile: e8.Value) =>
    insertLink(completeFile, linkLocation === "" ? undefined : linkLocation, description === "" ? undefined : description, e8.calledInteractively()),
});

/**
 * Inserts the stored links, each on a line of its own after "- ", as
 * org-insert-all-links does: with C-u keeping them stored, with a number
 * that many of the newest.
 */
function insertAllLinks(arg: e8.Value, pre = "- ", post = "\n"): void {
  const stored = storedLinks();
  if (stored.length === 0) {
    e8.message("No link to insert");
    return;
  }
  const count = typeof arg === "number" ? arg : arg === "-" ? -1 : undefined;
  e8.letBind({ "org-link-keep-stored-after-insertion": isPrefix(arg, 1) }, () => {
    const links = [...stored];
    for (let n = 1; count === undefined || count >= n; n++) {
      let l: StoredLink | undefined;
      if (count === undefined) l = links.shift();
      else {
        const now = storedLinks();
        l = now[0];
        if (l) e8.setVariable("org-stored-links", now.slice(1));
      }
      if (!l) break;
      e8.insert(pre);
      insertLink(null, l[0], l[1] ?? "<no description>");
      e8.insert(post);
    }
  });
}

e8.defineCommand({
  name: "org-insert-all-links",
  doc: 'Insert all the stored links, each on its own line after "- ", removing them from org-stored-links; with C-u keeping them, with a number the newest that many.',
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.Value) => insertAllLinks(arg),
});

e8.defineCommand({
  name: "org-insert-last-stored-link",
  doc: "Insert the link stored last, and a newline; with a count, the newest that many.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => insertAllLinks(arg, "", "\n"),
});
