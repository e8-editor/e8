// Org macros, after org-macro.el: {{{title}}}, {{{date(FORMAT)}}},
// {{{n}}}, {{{property(NAME)}}}, {{{keyword(NAME)}}}, {{{time(FORMAT)}}},
// {{{input-file}}}, {{{modification-time(FORMAT)}}} and those #+MACRO:
// defines, expanded in the buffer before an export parses it.
//
// A macro defined as (eval ...) is Lisp, which E8 does not evaluate
// (ADR 0116): expanding one is an error.

import { type Node, map } from "org-element-ast";
import { parseSecondaryString, restriction } from "org-element";
import { allKeywords, entryGetInherited, headingIndex, headings, keywordLines } from "org";
import { regexpQuote } from "subr";
import { entryGet } from "org-list";

/** A template: text with $1, $2 ... for the arguments, or a function of them. */
export type Template = string | ((...args: string[]) => string | undefined);

e8.defineVariable({ name: "org-macro-templates", value: [], local: true, doc: "The buffer's macro templates, as [name, template] pairs, as org-macro-initialize-templates sets them." });

let templates: [string, Template][] = [];
let counters = new Map<string, number>();

/** The templates the last initialization collected. */
export function currentTemplates(): [string, Template][] {
  return templates;
}

/** The value of the first keyword NAME, or of all of them joined with spaces with `collect`, as org-macro--find-keyword-value. */
export function findKeywordValue(name: string, collect = false): string | undefined {
  const re = new RegExp(`^[ \\t]*#\\+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*(.*?)[ \\t]*$`, "i");
  let result: string | undefined;
  return e8.saveRestriction(() => {
    e8.widen();
    // The lines that start so, found in one pass, as Org's re-search-forward finds them.
    for (const [, , text] of e8.matchingLines(`^[ \t]*#\\+${regexpQuote(name)}:`, { caseFold: true })) {
      const m = re.exec(text);
      if (!m) continue;
      if (!collect) return m[1];
      result = `${result ?? ""} ${m[1]}`;
    }
    return result?.trim();
  });
}

function setTemplates(list: [string, Template][]): [string, Template][] {
  const out: [string, Template][] = [];
  for (const [name, value] of list) {
    let v = value;
    if (typeof v === "string" && /^\(eval\b/.test(v)) {
      const source = v;
      v = () => e8.userError(`Macro ${name} is Lisp, which E8 does not evaluate: ${source}`);
    }
    const old = out.find(([n]) => n === name);
    if (old) {
      if (v) old[1] = v;
    } else out.unshift([name, v ?? ""]);
  }
  return out;
}

function collectMacros(): [string, Template][] {
  const list: [string, Template][] = [
    ["author", findKeywordValue("AUTHOR", true) ?? ""],
    ["email", findKeywordValue("EMAIL") ?? ""],
    ["title", findKeywordValue("TITLE", true) ?? ""],
    ["date", findDate()],
  ];
  // MACRO keywords as org-collect-keywords finds them: real keywords, not
  // lines of a block, and those of #+SETUPFILE: files in their places.
  for (const [, , text] of keywordLines()) {
    const m = /^[ \t]*#\+MACRO:[ \t]*(\S+)[ \t]*(.*?)[ \t]*$/i.exec(text);
    if (m) list.unshift([m[1], m[2]]);
  }
  return list;
}

/** The date macro: the DATE keyword, formatted when it is a timestamp alone and a format is given, as org-macro--find-date. */
function findDate(): Template {
  const value = findKeywordValue("DATE");
  if (value === undefined) return "";
  const date = parseSecondaryString(value, restriction("keyword"));
  if (date.length === 1 && typeof date[0] !== "string" && date[0].type === "timestamp") {
    const ts = date[0] as Node;
    return (fmt?: string) => {
      if (!fmt || !/\S/.test(fmt)) return value;
      const p = ts.p;
      const time = e8.encodeTime([0, p["minute-start"] ?? 0, p["hour-start"] ?? 0, p["day-start"], p["month-start"], p["year-start"]]);
      return e8.formatTimeString(fmt, time);
    };
  }
  return value;
}

/** Collect the buffer's templates with `defaults` first, as org-macro-initialize-templates. */
export function initializeTemplates(defaults: [string, string][] = []): void {
  counters = new Map();
  const source = e8.variable("e8--export-source-file");
  const visited = typeof source === "string" ? source : e8.bufferFileName();
  templates = [
    ...setTemplates([...(Array.isArray(defaults) ? defaults : []), ...collectMacros()]),
    ...(visited && e8.fileExists(visited)
      ? ([
          ["input-file", e8.fileNameNondirectory(visited)],
          [
            "modification-time",
            (fmt: string) => {
              const attrs = e8.fileAttributes(visited);
              return e8.formatTimeString(fmt, attrs ? attrs.modified / 1000 : undefined);
            },
          ],
        ] as [string, Template][])
      : []),
    ["keyword", (name: string) => findKeywordValue(name, true)],
    ["n", (name?: string, action?: string) => String(counterIncrement(name, action))],
    ["property", (name: string, location?: string) => getProperty(name, location)],
    ["time", (fmt: string) => e8.formatTimeString(fmt)],
  ];
  e8.setVariable("org-macro-templates", templates.filter(([, t]) => typeof t === "string") as any);
}

function counterIncrement(name?: string, action?: string): number {
  const key = typeof name === "string" ? name.trim() : "";
  const a = action && /\S/.test(action) ? action.trim() : undefined;
  let value: number;
  if (a === undefined) value = (counters.get(key) ?? 0) + 1;
  else if (a === "-") value = counters.get(key) ?? 1;
  else if (/^[0-9]+$/.test(a)) value = parseInt(a, 10);
  else value = 1;
  counters.set(key, value);
  return value;
}

/** A property of the entry at point, or of the heading `location` names, as org-macro--get-property. */
function getProperty(name: string, location?: string): string | undefined {
  return e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      const all = headings();
      let i: number | undefined;
      if (location && /\S/.test(location)) {
        const target = location.replace(/^\*/, "").trim();
        i = all.findIndex((h) => h.title === target || entryGet(h.line, "CUSTOM_ID") === target.replace(/^#/, ""));
        if (i < 0) e8.signal("error", `Macro property failed: cannot find location ${location}`);
      } else i = headingIndex(all, e8.lineOf(e8.point()));
      if (i === undefined) return undefined;
      const inherit = e8.variable("org-use-property-inheritance");
      return inherit === true ? entryGetInherited(all[i], name) : entryGet(all[i].line, name);
    }),
  );
}

/** Expand a macro's template with its arguments, as org-macro-expand. */
export function expand(key: string, args: string[], list: [string, Template][] = templates): string | undefined {
  const template = list.find(([n]) => n.toLowerCase() === key.toLowerCase())?.[1];
  if (template === undefined) return undefined;
  const value = typeof template === "function" ? template(...args) : template.replace(/\$[0-9]+/g, (m) => args[parseInt(m.slice(1), 10) - 1] ?? "");
  return String(value ?? "");
}

/** A macro's arguments, split at unescaped commas, as org-macro-extract-arguments. */
export function extractArguments(s: string): string[] {
  return s
    .replace(/(\\*),/g, (_m, slashes: string) => "\\".repeat(Math.floor(slashes.length / 2)) + (slashes.length % 2 === 0 ? "\u0000" : ","))
    .split("\u0000");
}

const MACRO = /\{\{\{([a-zA-Z][-a-zA-Z0-9_]*)(?:\(([^\u0000]*?)\))?\}\}\}/g;

/**
 * Expand every macro in the buffer, as org-macro-replace-all: in text, and
 * in the keywords named (TITLE and its kin) and their EXPORT_ properties.
 */
export function replaceAll(list: [string, Template][] = templates, keywords: string[] = []): void {
  const record = new Set<string>();
  // The parsed keywords given, and captions, whose values Org's parser finds macros in.
  const keywordRe = new RegExp(`^[ \\t]*#\\+(${[...keywords, "CAPTION(?:\\[.*\\])?"].join("|")}):`, "i");
  const propertyRe = new RegExp(`^[ \\t]*:EXPORT_(${keywords.join("|") || "\\u0000"})\\+?:`, "i");
  e8.saveRestriction(() => {
    e8.widen();
    let open: string | undefined;
    let commentedLevel: number | undefined;
    // A commented heading, as org-in-commented-heading-p reads one: COMMENT after its keyword and priority.
    const todo = allKeywords().map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const commented = new RegExp(`^\\*+[ \\t]+(?:(?:${todo || "\\u0000"})[ \\t]+)?(?:\\[#.\\][ \\t]+)?COMMENT(?:[ \\t]|$)`);
    for (let l = 0; l < e8.lineCount(); l++) {
      const text = e8.lineText(l);
      const heading = /^(\*+)\s/.exec(text);
      if (heading) {
        const level = heading[1].length;
        if (commentedLevel !== undefined && level <= commentedLevel) commentedLevel = undefined;
        if (commentedLevel === undefined && commented.test(text)) commentedLevel = level;
      }
      if (open) {
        if (new RegExp(`^[ \\t]*#\\+end_${open}\\b`, "i").test(text)) open = undefined;
        continue;
      }
      const b = /^[ \t]*#\+begin_(src|example|export|comment)\b/i.exec(text);
      if (b) {
        open = b[1].toLowerCase();
        continue;
      }
      if (commentedLevel !== undefined || !text.includes("{{{")) continue;
      if (/^[ \t]*#\+/.test(text) && !keywordRe.test(text)) continue;
      if (/^[ \t]*(#( |$)|:( |$))/.test(text)) continue;
      if (/^[ \t]*:[-\w]+\+?:/.test(text) && !propertyRe.test(text)) continue;
      const isText = !keywordRe.test(text) && !propertyRe.test(text);
      // Again from the line's start after each expansion, as Org goes on from the macro's start.
      for (let guard = 0; guard < 10000; guard++) {
        const line = e8.lineText(l);
        const allowed = isText ? macrosAsObjects(line) : undefined;
        MACRO.lastIndex = 0;
        let m: RegExpExecArray | null;
        let done = true;
        while ((m = MACRO.exec(line))) {
          if (allowed && !allowed.has(m[0])) continue;
          const key = m[1].toLowerCase();
          // Trimmed, and runs of blanks made one space, as org-element-macro-parser reads them.
          const args = m[2] === undefined ? [] : extractArguments(m[2].trim().replace(/[ \t\r\n]+/g, " "));
          const begin = e8.lineStart(l) + [...line.slice(0, m.index)].length;
          // Point at the macro, as Org's search leaves it, for {{{property}}} to read its entry.
          e8.gotoChar(begin);
          const value = expand(key, args, list);
          const signature = `${begin}\u0000${m[0]}`;
          if (value !== undefined) {
            if (record.has(signature)) e8.signal("error", `Circular macro expansion: ${key}`);
            record.add(signature);
            const end = begin + [...m[0]].length;
            e8.deleteRegion(begin, end);
            e8.gotoChar(begin);
            e8.insert(value);
            done = false;
            break;
          } else if (key !== "results") e8.signal("error", `Undefined Org macro: ${key}; aborting`);
        }
        if (done) break;
      }
    }
  });
}

/** The macros Org's parser finds as objects in a line of text, by their text: none inside code or verbatim. */
function macrosAsObjects(line: string): Set<string> {
  const out = new Set<string>();
  map(parseSecondaryString(line, restriction("paragraph")), "macro", (m) => {
    out.add(String((m as Node).p.value));
    return undefined;
  });
  return out;
}
