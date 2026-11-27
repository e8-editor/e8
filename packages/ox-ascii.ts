// Org's plain text backend, after ox-ascii.el: ASCII, Latin-1 and UTF-8
// text, filled to org-ascii-text-width, with underlined headings, boxed
// blocks, drawn tables and notes for links and footnotes. On C-c C-e t.

import { ALL_ELEMENTS, type Datum, type Node, ancestor, contents, lineage, map, mapFirst, property, typeOf } from "org-element-ast";
import { interpretData, normalizeString } from "org-element";
import { EXPORT_PARAMS } from "org-loaddefs";
import { fillRegionAsParagraph } from "fill";
import {
  type Info,
  activateSmartQuotes,
  collectFootnoteDefinitions,
  collectHeadlines,
  collectListings,
  collectTables,
  customProtocolMaybe,
  data,
  defineBackend,
  flag,
  formatCodeDefault,
  getAltTitle,
  getCaption,
  getCoderefFormat,
  getDate,
  getFootnoteNumber,
  getHeadlineNumber,
  getNextElement,
  getOrdinal,
  getPreviousElement,
  getRelativeLevel,
  getTags,
  itemNumber,
  lowLevelP,
  mapOpts,
  nonNil,
  numberedHeadlineP,
  outputFileName,
  readAttribute,
  removeIndentation,
  resolveCoderef,
  resolveFuzzyLink,
  resolveIdLink,
  resolveLink,
  snippetBackend,
  stringAs,
  tableCellAlignment,
  tableCellBorders,
  tableCellWidth,
  toBuffer,
  toFile,
  translate,
  varValue,
} from "ox";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
const sym = (name: string) => e8.intern(name);

defvar("org-ascii-text-width", 72, "The maximum width of exported text, in characters, not counting the global margin.");
defvar("org-ascii-global-margin", 0, "The width of the left margin, in spaces.");
defvar("org-ascii-inner-margin", 2, "The indentation of text under a heading, in spaces.");
defvar("org-ascii-quote-margin", 6, "The indentation of quotes and verses, in spaces, on each side.");
defvar("org-ascii-list-margin", 0, "The indentation of top-level lists, in spaces.");
defvar("org-ascii-inlinetask-width", 30, "The width of inline tasks, in characters.");
defvar("org-ascii-headline-spacing", [1, 2], "The blank lines before and after a heading's contents, as (BEFORE . AFTER), or nil to keep the document's.");
defvar("org-ascii-indented-line-width", sym("auto"), "The indentation of a paragraph's first line: a number of spaces, or auto to keep the document's.");
defvar("org-ascii-paragraph-spacing", sym("auto"), "The blank lines between paragraphs: a number, or auto to keep the document's.");
defvar("org-ascii-charset", sym("ascii"), "The character set exported to: ascii, latin1 or utf-8.");
defvar("org-ascii-underline", [[sym("ascii"), "=", "~", "-"], [sym("latin1"), "=", "~", "-"], [sym("utf-8"), "═", "─", "╌", "┄", "┈"]], "The characters underlining headings of each level, by character set.");
defvar("org-ascii-bullets", [[sym("ascii"), "*", "+", "-"], [sym("latin1"), "§", "¶"], [sym("utf-8"), "◊"]], "The bullets of headings deeper than the levels exported as headings, by character set.");
defvar("org-ascii-links-to-notes", true, "Whether links' destinations go in notes after the section, rather than after each link.");
defvar("org-ascii-table-keep-all-vertical-lines", false, "Whether every vertical line of a table is kept.");
defvar("org-ascii-table-widen-columns", true, "Whether columns are widened to fit their text, rather than truncated to their width cookie.");
defvar("org-ascii-table-use-ascii-art", false, "Whether table.el tables are drawn with box characters, for UTF-8.");
defvar("org-ascii-caption-above", false, "Whether captions go above tables and listings rather than below.");
defvar("org-ascii-verbatim-format", "`%s'", "The format of verbatim and code text.");
defvar("org-ascii-format-drawer-function", null, "A function formatting a drawer: given its name, contents and width, it returns the text. nil exports its contents.");
defvar("org-ascii-format-inlinetask-function", null, "A function formatting an inline task, as org-ascii-format-inlinetask-default does; nil uses that.");

// --- Text ---------------------------------------------------------------------

/** What a line break leaves: a newline marked as one fill keeps, as Emacs's hard-newline is. */
const HARD = "";
const HARD_NEWLINE = HARD + "\n";

let fillBuffer: string | undefined;

/** A buffer of its own for filling and justifying, reused, as with-temp-buffer gives one. */
function inFillBuffer<T>(text: string, body: () => T): T {
  if (fillBuffer === undefined || !e8.getBuffer(fillBuffer)) {
    fillBuffer = e8.generateNewBufferName(" *org-ascii fill*");
    e8.getBufferCreate(fillBuffer);
  }
  return e8.withCurrentBuffer(fillBuffer, () => {
    e8.letBind({ "inhibit-read-only": true }, () => e8.deleteRegion(e8.pointMin(), e8.pointMax()));
    e8.insert(text);
    return body();
  });
}

/** The fill buffer killed, at the end of an export. */
function killFillBuffer(): void {
  if (fillBuffer !== undefined && e8.getBuffer(fillBuffer)) e8.call("kill-buffer", fillBuffer);
  fillBuffer = undefined;
}

/** Text filled to a width, each part between hard newlines a paragraph, justified as `how` says, as org-ascii--fill-string. */
function fillString(s: string | undefined, width: number, info: Info, how?: string): string | undefined {
  if (typeof s !== "string") return undefined;
  if (nonNil(info["preserve-breaks"])) s = s.replace(/\n/g, HARD_NEWLINE).replace(new RegExp(`${HARD}+`, "g"), HARD);
  const doubleSpace = e8.variable("sentence-end-double-space");
  const parts = s.split(HARD_NEWLINE);
  const filled = parts.map((part) => {
    const out = inFillBuffer(part, () =>
      e8.letBind({ "fill-column": width, "sentence-end-double-space": doubleSpace ?? true, "fill-prefix": null, "left-margin": 0 }, () => {
        fillRegionAsParagraph(e8.pointMin(), e8.pointMax());
        return e8.bufferText();
      }),
    );
    return how === "center" || how === "right" ? justifyLines(out, width, how, true) : out;
  });
  return filled.join(HARD_NEWLINE);
}

/** The columns from one to another as whitespace, as indent-to inserts it: tabs too unless `spaces`. */
function indentString(from: number, to: number, spaces: boolean): string {
  if (to <= from) return "";
  if (spaces) return " ".repeat(to - from);
  const tab = Number(e8.variable("tab-width") ?? 8);
  let out = "";
  let col = from;
  while (Math.floor(col / tab) < Math.floor(to / tab)) {
    out += "\t";
    col = (Math.floor(col / tab) + 1) * tab;
  }
  return out + " ".repeat(to - col);
}

/** The column after some text, tabs to tab stops, as current-column counts. */
function columnAfter(text: string, start = 0): number {
  const tab = Number(e8.variable("tab-width") ?? 8);
  let col = start;
  for (const ch of text) col = ch === "\t" ? (Math.floor(col / tab) + 1) * tab : col + e8.stringWidth(ch);
  return col;
}

const ADAPTIVE_FILL = /^[-–!|#%;>*·•‣⁃◦ \t]*/;

/** One line justified right or centered within a width, as justify-current-line. */
function justifyLine(line: string, width: number, how: string, tabs: boolean): string {
  const trimmed = line.replace(/[ \t]+$/, "");
  if (trimmed === "" || !/\S/.test(trimmed)) return line;
  const endcolFull = columnAfter(trimmed);
  if (how === "right" && endcolFull === width) return line;
  const fpEnd = ADAPTIVE_FILL.exec(trimmed)![0].replace(/[^ \t]+[ \t]*$/, (m) => m).length;
  // The fill prefix: what adaptive-fill-regexp matches; beg after the blanks that follow.
  const prefixMatch = ADAPTIVE_FILL.exec(trimmed)![0];
  const lead = /^[ \t]*/.exec(trimmed)![0];
  const prefixEnd = prefixMatch.length >= lead.length ? prefixMatch.length : lead.length;
  void fpEnd;
  let beg = prefixEnd;
  while (beg < trimmed.length && (trimmed[beg] === " " || trimmed[beg] === "\t")) beg++;
  const indent = columnAfter(trimmed.slice(0, beg));
  const text = trimmed.slice(beg);
  const endcol = endcolFull;
  const fpEndText = trimmed.slice(0, prefixMatch.length);
  const fpEndCol = columnAfter(fpEndText);
  let ncols: number;
  if (how === "right") ncols = indent + (width - endcol);
  else ncols = Math.floor((width - (endcol - indent)) / 2);
  if (ncols < indent) {
    // Less indentation: from the fill prefix's end, as far as the new column.
    const keep = Math.max(fpEndCol, ncols);
    return trimmed.slice(0, prefixMatch.length) + " ".repeat(Math.max(0, keep - fpEndCol)) + text + line.slice(trimmed.length);
  }
  return trimmed.slice(0, beg) + indentString(indent, ncols, !tabs) + text + line.slice(trimmed.length);
}

/** Each line justified, as org-ascii--justify-lines does with indent-tabs-mode off. */
function justifyLines(s: string, width: number, how: string, tabs = false): string {
  if (how === "left" || how === "none") return s;
  return s
    .split("\n")
    .map((l) => justifyLine(l, width, how, tabs && nonNil(e8.defaultValue("indent-tabs-mode"))))
    .join("\n");
}

/** An element's contents justified as its container says, as org-ascii--justify-element. */
function justifyElement(c: string | undefined, element: Node, info: Info): string | undefined {
  if (c === undefined || !/\S/.test(c)) return c;
  const width = currentTextWidth(element, info);
  const how = currentJustification(element);
  if (element.type === "paragraph") return fillString(c, width, info, how);
  if (how === "left") return c;
  const lines = c.split("\n");
  let maxWidth = 0;
  for (const l of lines) {
    if (/^[ \t]*$/.test(l)) continue;
    const col = columnAfter(l);
    if (col >= width) return c;
    if (col > maxWidth) maxWidth = col;
  }
  const offset = Math.floor((width - maxWidth) / (how === "right" ? 1 : 2));
  if (offset === 0) return c;
  const tabs = nonNil(e8.defaultValue("indent-tabs-mode"));
  return lines
    .map((l) => {
      if (/^[ \t]*$/.test(l)) return l;
      // indent-to-column at the line's start: the text keeps its own indentation after.
      return indentString(0, offset, !tabs) + l;
    })
    .join("\n");
}

/** Each line with text indented by `width` more spaces, as org-ascii--indent-string. */
function indentLines(s: string | undefined, width: number): string | undefined {
  if (typeof s !== "string") return undefined;
  if (width === 0) return s;
  const pad = " ".repeat(width);
  return s.replace(/^(?=[ \t]*\S)/gm, pad);
}

/** Text in a box, as org-ascii--box-string. */
function boxString(s: string, info: Info): string {
  const utf8 = info["ascii-charset"] === "utf-8";
  const body = s.replace(/\n[ \t]*$/, "").replace(/^/gm, utf8 ? "│ " : "| ");
  return utf8 ? `┌────\n${body}\n└────` : `,----\n${body}\n\`----`;
}

const trim = (s: string) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
const stringWidth = (s: string) => e8.stringWidth(s);

/** The width an element's text has, after margins and indentation, as org-ascii--current-text-width. */
function currentTextWidth(element: Node, info: Info): number {
  if (element.type === "inlinetask") return info["ascii-inlinetask-width"];
  if (element.type === "headline") {
    const low = lowLevelP(element, info);
    return info["ascii-text-width"] - (low !== undefined ? low * 2 : info["ascii-global-margin"]);
  }
  const genealogy = lineage(element, undefined, true) as Node[];
  const total = genealogy.some((p) => p.type === "inlinetask")
    ? info["ascii-inlinetask-width"]
    : info["ascii-text-width"] -
      info["ascii-global-margin"] -
      (() => {
        const parent = ancestor(element, ["headline"]) as Node | undefined;
        if (!parent) return 0;
        const low = lowLevelP(parent, info);
        return low !== undefined ? low * 2 : info["ascii-inner-margin"];
      })();
  const quotes = genealogy.filter((p) => p.type === "quote-block" || p.type === "verse-block").length * 2 * info["ascii-quote-margin"];
  const lists = genealogy.filter((e) => e.type === "plain-list" && e.parent?.type !== "item").length * info["ascii-list-margin"];
  let indentation = 0;
  for (const e of genealogy) {
    if (e.type !== "item") continue;
    if (e.parent?.p.type === "descriptive") indentation += Number(varValue("org-ascii-quote-margin"));
    else indentation += stringWidth(checkbox(e, info) ?? "") + stringWidth(e.p.bullet ?? "");
  }
  return total - (quotes + lists + indentation);
}

/** How an element is justified, by the center or JUSTIFYRIGHT and JUSTIFYLEFT blocks around it, as org-ascii--current-justification. */
function currentJustification(element: Node): string {
  for (const el of lineage(element, undefined, true) as Node[]) {
    if (el.type === "center-block") return "center";
    if (el.type === "special-block") {
      const name = el.p.type;
      if (name === "JUSTIFYRIGHT") return "right";
      if (name === "JUSTIFYLEFT") return "left";
    }
  }
  return "left";
}

/** Tags as org-make-tag-string writes them: :a:b:. */
const tagString = (tags: string[]) => (tags.length ? `:${tags.join(":")}:` : "");

/** A heading's or inline task's title line, numbered, with its keyword, priority and tags, and underlined, as org-ascii--build-title. */
function buildTitle(element: Node, info: Info, textWidth: number, underline = false, notags = false, toc = false): string {
  const headlinep = element.type === "headline";
  let numbers = "";
  if (headlinep && numberedHeadlineP(element, info)) {
    const numbering = getHeadlineNumber(element, info) ?? [];
    numbers = toc ? `${numbering[numbering.length - 1]}. ` : numbering.join(".") + " ";
  }
  const text = trim(data(toc && headlinep ? getAltTitle(element, info) : element.p.title, info));
  const todo = nonNil(info["with-todo-keywords"]) && element.p["todo-keyword"] ? data(element.p["todo-keyword"], info) + " " : "";
  const tagList = !notags && nonNil(info["with-tags"]) ? getTags(element, info) : [];
  const tags = tagList.length ? tagString(tagList) : undefined;
  const priority = nonNil(info["with-priority"]) && element.p.priority !== undefined ? `(#${String.fromCodePoint(element.p.priority)}) ` : "";
  const firstPart = numbers + todo + priority + text;
  let out = firstPart;
  if (tags) out += " " + tags.padStart(Math.max(textWidth - (1 + stringWidth(firstPart)), stringWidth(tags)));
  if (underline && headlinep) {
    const chars = charsetList(info["ascii-underline"], info["ascii-charset"]);
    const under = chars[getRelativeLevel(element, info) - 1];
    if (under) out += "\n" + under.repeat(Math.floor(stringWidth(firstPart) / stringWidth(under)));
  }
  return out;
}

/** The characters an alist of character sets gives for one: underline or bullet characters, as strings. */
function charsetList(alist: any, charset: string): string[] {
  const entry = Array.isArray(alist) ? alist.find((e: any) => Array.isArray(e) && String(e[0]) === charset) : undefined;
  return entry ? entry.slice(1).map((c: any) => (typeof c === "number" ? String.fromCodePoint(c) : String(c))) : [];
}

const hasCaptionP = (element: Datum) => nonNil(property("caption", element));

function buildCaption(element: Node, info: Info): string | undefined {
  const caption = getCaption(element);
  if (!caption) return undefined;
  const reference = getOrdinal(element, info, undefined, hasCaptionP);
  const fmt = asciiTranslate(element.type === "table" ? "Table %d:" : "Listing %d:", info);
  return fillString(`${fmt.replace("%d", String(reference))} ${data(caption, info)}`, currentTextWidth(element, info), info);
}

function rule(title: string, info: Info): string {
  return title + "\n" + (info["ascii-charset"] === "utf-8" ? "─" : "_").repeat(stringWidth(title));
}

function buildToc(info: Info, n?: number, keyword?: Node, scope?: Datum): string {
  const head = scope ? "" : rule(asciiTranslate("Table of Contents", info), info) + "\n\n";
  const textWidth = keyword ? currentTextWidth(keyword, info) : info["ascii-text-width"] - info["ascii-global-margin"];
  return (
    head +
    collectHeadlines(info, n, scope)
      .map((h) => {
        const level = getRelativeLevel(h, info);
        const indent = (level - 1) * 3;
        return (
          (indent === 0 ? "" : ".".repeat(indent - 1) + " ") +
          buildTitle(h, info, textWidth - indent, false, !nonNil(info["with-tags"]) || info["with-tags"] === "not-in-toc", true)
        );
      })
      .join("\n")
  );
}

function listOf(title: string, numberFmt: string, items: Node[], keyword: Node | undefined, info: Info): string {
  const textWidth = keyword ? currentTextWidth(keyword, info) : info["ascii-text-width"] - info["ascii-global-margin"];
  let count = 0;
  return (
    rule(asciiTranslate(title, info), info) +
    "\n\n" +
    items
      .map((el) => {
        const initial = asciiTranslate(numberFmt, info).replace("%d", String(++count));
        const w = stringWidth(initial);
        return `${initial} ${trim(indentLines(fillString(data(getCaption(el, true) ?? getCaption(el), info), textWidth - w, info), w) ?? "")}`;
      })
      .join("\n")
  );
}

/** The links of a section, or of a heading's title and first section, each once, as org-ascii--unique-links. */
function uniqueLinks(element: Node, info: Info): Node[] {
  const seen: string[] = [];
  const memo = info["exported-data"] as Map<Datum, string>;
  const target = element.type === "section" ? element : [...(element.p.title ?? []), element.contents[0]].filter((x) => x !== undefined);
  return map(
    target,
    "link",
    (l) => {
      const link = l as Node;
      const c = link.contents.length ? trim(interpretData(link.contents)).replace(/[ \r\t\n]+/g, " ") : "";
      const footprint = JSON.stringify([link.p["raw-link"], c]);
      const done = memo.get(link);
      if (done !== undefined && /\S/.test(done) && !seen.includes(footprint)) {
        seen.push(footprint);
        return link;
      }
      return undefined;
    },
    mapOpts(info, { noRecursion: ["headline"], withAffiliated: true }),
  );
}

function describeDatum(datum: Datum | string, info: Info): string {
  if (typeof datum === "string") return `See file ${datum}`;
  if (datum.type === "headline")
    return asciiTranslate("See section %s", info).replace("%s", numberedHeadlineP(datum, info) ? (getHeadlineNumber(datum, info) ?? []).join(".") : data(datum.p.title, info));
  const number = getOrdinal(datum, info, undefined, hasCaptionP);
  const enumerable = ancestor(datum, ["headline", "paragraph", "src-block", "table"], true) as Node | undefined;
  switch (enumerable?.type) {
    case "headline":
      return asciiTranslate("See section %s", info).replace("%s", numberedHeadlineP(enumerable, info) ? [].concat(number).join(".") : data(enumerable.p.title, info));
  }
  if (number === undefined) return asciiTranslate("Unknown reference", info);
  switch (enumerable?.type) {
    case "paragraph":
      return asciiTranslate("See figure %s", info).replace("%s", String(number));
    case "src-block":
      return asciiTranslate("See listing %s", info).replace("%s", String(number));
    case "table":
      return asciiTranslate("See table %s", info).replace("%s", String(number));
  }
  return asciiTranslate("Unknown reference", info);
}

function describeLinks(links: Node[], width: number, info: Info): string {
  return links
    .map((link) => {
      const type = link.p.type;
      const description = link.contents.length ? link.contents : undefined;
      const anchor = data(description ?? link.p["raw-link"], info);
      if (type === "coderef" || type === "radio") return "";
      if (type === "custom-id" || type === "fuzzy" || type === "id") {
        if (!description) return "";
        let dest: Datum | string | undefined;
        try {
          dest = type === "fuzzy" ? resolveFuzzyLink(link, info) : resolveIdLink(link, info);
        } catch (e) {
          if (!(e instanceof Error && /Unable to resolve link/.test(e.message))) throw e;
        }
        return dest ? fillString(`[${anchor}] ${describeDatum(dest, info)}`, width, info) + "\n\n" : "";
      }
      if (!link.contents.length) return "";
      if (customProtocolMaybe(link, anchor, "ascii", info)) return "";
      return fillString(`[${anchor}] <${link.p["raw-link"]}>`, width, info) + "\n\n";
    })
    .join("");
}

function checkbox(item: Node, info: Info): string | undefined {
  const utf8 = info["ascii-charset"] === "utf-8";
  switch (item.p.checkbox) {
    case "on":
      return utf8 ? "☑ " : "[X] ";
    case "off":
      return utf8 ? "☐ " : "[ ] ";
    case "trans":
      return utf8 ? "☒ " : "[-] ";
  }
  return undefined;
}

function asciiTranslate(s: string, info: Info): string {
  return translate(s, String(info["ascii-charset"]), info);
}

const nw = (s: string | undefined | false): s is string => typeof s === "string" && /\S/.test(s);

// --- Template -------------------------------------------------------------------

function documentTitle(info: Info): string {
  const textWidth: number = info["ascii-text-width"];
  const i: Info = { ...info, "ascii-links-to-notes": false };
  const withTitle = nonNil(i["with-title"]);
  const title = data(withTitle ? i["title"] : undefined, i);
  const subtitle = data(withTitle ? i["subtitle"] : undefined, i);
  const author = nonNil(i["with-author"]) && nonNil(i["author"]) ? data(i["author"], i) : undefined;
  const email = nonNil(i["with-email"]) ? data(i["email"], i) : undefined;
  const date = nonNil(i["with-date"]) ? data(getDate(i), i) : undefined;
  if (title === "") {
    if (nw(date) && nw(author)) return author + " ".repeat(textWidth - stringWidth(date) - stringWidth(author)) + date + (nw(email) ? "\n" + email : "") + "\n\n\n";
    if (nw(date) && nw(email)) return email + " ".repeat(textWidth - stringWidth(date) - stringWidth(email)) + date + "\n\n\n";
    if (nw(date)) return justifyLines(date, textWidth, "right") + "\n\n\n";
    if (nw(author) && nw(email)) return author + "\n" + email + "\n\n\n";
    if (nw(author)) return author + "\n\n\n";
    if (nw(email)) return email + "\n\n\n";
    return "";
  }
  const utf8 = i["ascii-charset"] === "utf-8";
  const titleLen = Math.min(
    Math.max(...(title + "\n" + subtitle).split("\n").filter((l) => l !== "").map(stringWidth)),
    Math.floor((2 * textWidth) / 3),
  );
  const formattedTitle = fillString(title, titleLen, i)!;
  const formattedSubtitle = nw(subtitle) ? fillString(subtitle, titleLen, i) : undefined;
  const line = (utf8 ? "━" : "_").repeat(Math.min(Math.max(titleLen, stringWidth(author ?? ""), stringWidth(email ?? "")) + 2, textWidth));
  return justifyLines(
    line +
      "\n" +
      (utf8 ? "" : "\n") +
      formattedTitle.toUpperCase() +
      (formattedSubtitle ? "\n" + formattedSubtitle : "") +
      (nw(author) && nw(email) ? "\n\n" + author + "\n" + email : nw(author) ? "\n\n" + author : nw(email) ? "\n\n" + email : "") +
      "\n" +
      line +
      (nw(date) ? "\n\n\n" + date : "") +
      "\n\n\n",
    textWidth,
    "center",
  );
}

function innerTemplate(c: string, info: Info): string {
  const margin: number = info["ascii-global-margin"];
  const definitions = collectFootnoteDefinitions(info);
  const i: Info = { ...info, "ascii-links-to-notes": false };
  let notes = "";
  if (definitions.length) {
    const textWidth = i["ascii-text-width"] - margin;
    notes =
      "\n\n\n" +
      rule(asciiTranslate("Footnotes", i), i) +
      "\n\n" +
      definitions
        .map(([n, , def]) => {
          const id = `[${n}] `;
          if (typeof def !== "string" && mapFirst(def, ALL_ELEMENTS, (x) => x, mapOpts(i))) {
            const first = def[0];
            if (typeOf(first) !== "paragraph") return trim(id + "\n" + data(def, i));
            const p = first as Node;
            const saved = p.contents;
            p.contents = [id, ...saved];
            (i["exported-data"] as Map<Datum, string>).delete(p);
            try {
              return trim(data(def, i));
            } finally {
              p.contents = saved;
            }
          }
          return trim(fillString(id + data(def, i), textWidth, i) ?? "");
        })
        .join("\n\n");
  }
  return normalizeString(indentLines(c + notes, margin) ?? "");
}

function template(c: string, info: Info): string {
  const margin: number = info["ascii-global-margin"];
  const depth = info["with-toc"];
  const head = documentTitle(info) + (nonNil(depth) ? buildToc(info, typeof depth === "number" ? depth : undefined) + "\n\n\n" : "");
  const creator = nonNil(info["with-creator"])
    ? indentLines("\n\n\n" + fillString(info["creator"], info["ascii-text-width"] - margin, info, "right"), margin)
    : "";
  return (indentLines(head, margin) ?? "") + c + (creator ?? "");
}

// --- Transcoders -------------------------------------------------------------------

function timestampTranslate(ts: Node): string {
  return interpretData(ts).replace(/[ \t]+$/, "");
}

function plainText(text: string, info: Info): string {
  const utf8 = info["ascii-charset"] === "utf-8";
  if (utf8 && nonNil(info["with-smart-quotes"])) text = activateSmartQuotes(text, "utf-8", info);
  if (!nonNil(info["with-special-strings"])) return text;
  text = text.replace(/\\-/g, "");
  if (!utf8) return text;
  return text.replace(/---/g, "—").replace(/--/g, "–").replace(/\.\.\./g, "…");
}

function headline(h: Node, c: string | undefined, info: Info): string | undefined {
  if (nonNil(h.p["footnote-section-p"])) return undefined;
  const low = lowLevelP(h, info);
  const width = currentTextWidth(h, info);
  const title = buildTitle(h, info, width, low === undefined);
  const spacing = info["ascii-headline-spacing"];
  const pre = "\n".repeat(Array.isArray(spacing) ? spacing[0] : h.p["pre-blank"] ?? 0);
  const links = nonNil(info["ascii-links-to-notes"]) ? describeLinks(uniqueLinks(h, info), width, info) : "";
  let body = c ?? "";
  if (nw(links)) {
    const first = h.contents[0];
    const section = typeOf(first) === "section" ? (first as Node) : undefined;
    body =
      (section ? normalizeString(data(section, info)) + "\n\n" : "") +
      links +
      (section ? h.contents.slice(1) : h.contents).map((e) => data(e, info)).join("");
  }
  if (low !== undefined) {
    const bullets = charsetList(info["ascii-bullets"], info["ascii-charset"]);
    const bullet = `${bullets[(low - 1) % bullets.length]} `;
    return bullet + title + "\n" + pre + (indentLines(body, bullet.length) ?? "");
  }
  return title + "\n" + pre + body;
}

function item(it: Node, c: string | undefined, info: Info): string {
  const utf8 = info["ascii-charset"] === "utf-8";
  const box = checkbox(it, info) ?? "";
  const listType = it.parent?.p.type;
  let bullet: string;
  if (listType === "descriptive") bullet = box + data(it.p.tag, info);
  else if (listType === "ordered") {
    const bul = bulletString(it.p.bullet);
    const num = itemNumber(it);
    bullet = bul.replace(/[0-9A-Za-z]+/, String(num[num.length - 1]));
  } else {
    const bul = bulletString(it.p.bullet);
    bullet = utf8 ? bul.replace(/\*/g, "‣").replace(/\+/g, "⁃").replace(/-/g, "•") : bul;
  }
  const indentation = listType === "descriptive" ? Number(varValue("org-ascii-quote-margin")) : stringWidth(bullet);
  const indented = indentLines(c ?? "", indentation) ?? "";
  const firstNonEmpty = it.contents.find((e) => nw(data(e, info)));
  return (
    bullet +
    box +
    (listType !== "descriptive" && nw(indented) && typeOf(firstNonEmpty) === "paragraph" ? trim(indented) : "\n" + indented)
  );
}

/** A bullet as org-list-bullet-string makes it: one space after it. */
function bulletString(bullet: string): string {
  const m = /^\s*(\S+)/.exec(bullet ?? "-");
  return (m ? m[1] : "-") + " ";
}

function keyword(k: Node, _c: string | undefined, info: Info): string | undefined {
  const key = k.p.key;
  const value: string = k.p.value ?? "";
  if (key === "ASCII") return justifyElement(value, k, info);
  if (key === "TOC") {
    let out: string | undefined;
    if (/\bheadlines\b/i.test(value)) {
      const d = /\b[0-9]+\b/.exec(value);
      const depth = d ? parseInt(d[0], 10) : undefined;
      const t = /:target +(".+?"|\S+)/i.exec(value);
      const scope = t ? resolveLink(t[1].replace(/^"(.*)"$/, "$1"), info) : /\blocal\b/i.test(value) ? k : undefined;
      out = buildToc(info, depth, k, scope as Datum | undefined);
    } else if (/\btables\b/i.test(value)) out = listOf("List of Tables", "Table %d:", collectTables(info), k, info);
    else if (/\blistings\b/i.test(value)) out = listOf("List of Listings", "Listing %d:", collectListings(info), k, info);
    return justifyElement(out, k, info);
  }
  return undefined;
}

function link(l: Node, desc: string | undefined, info: Info): string | undefined {
  const type = l.p.type;
  const custom = customProtocolMaybe(l, desc, "ascii", info);
  if (custom) return custom;
  if (type === "coderef") {
    const ref = l.p.path;
    return getCoderefFormat(ref, desc).replace("%s", String(resolveCoderef(ref, info)));
  }
  if (type === "radio") return desc;
  if (type === "custom-id" || type === "fuzzy" || type === "id") {
    const destination = type === "fuzzy" ? resolveFuzzyLink(l, info) : resolveIdLink(l, info);
    if (desc) return nonNil(info["ascii-links-to-notes"]) ? `[${desc}]` : `[${desc}] (${describeDatum(destination, info)})`;
    if (typeof destination === "string") return destination;
    if (destination.type === "headline")
      return numberedHeadlineP(destination, info) ? (getHeadlineNumber(destination, info) ?? []).join(".") : data(destination.p.title, info);
    const number = getOrdinal(destination, info, undefined, hasCaptionP);
    if (number !== undefined) return Array.isArray(number) ? number.join(".") : String(number);
    return "???";
  }
  const path = l.p["raw-link"];
  if (!nw(desc)) return `<${path}>`;
  return `[${desc}]` + (nonNil(info["ascii-links-to-notes"]) ? "" : ` (<${path}>)`);
}

function paragraph(p: Node, c: string | undefined, info: Info): string | undefined {
  let text = (c ?? "").replace(/^[ \t]*\n/gm, "");
  const width = info["ascii-indented-line-width"];
  if (typeof width === "number" && Number.isInteger(width) && width >= 0) {
    const first = !getPreviousElement(p, info) && p.parent?.type === "section";
    text = (first ? "" : " ".repeat(width)) + text.replace(/^[ \t]+/, "");
  }
  return justifyElement(text, p, info);
}

function section(s: Node, c: string | undefined, info: Info): string | undefined {
  const links =
    nonNil(info["ascii-links-to-notes"]) && !ancestor(s, ["headline"]) ? describeLinks(uniqueLinks(s, info), currentTextWidth(s, info), info) : "";
  const h = ancestor(s, ["headline"]) as Node | undefined;
  return indentLines(nw(links) ? normalizeString(c ?? "") + "\n\n" + links : c, !h || lowLevelP(h, info) !== undefined ? 0 : info["ascii-inner-margin"]);
}

function srcBlock(b: Node, _c: string | undefined, info: Info): string | undefined {
  const caption = buildCaption(b, info);
  const above = nonNil(info["ascii-caption-above"]);
  const code = formatCodeDefault(b, info);
  if (code === "") return "";
  return justifyElement((caption && above ? caption + "\n" : "") + boxString(code, info) + (caption && !above ? "\n" + caption : ""), b, info);
}

function table(t: Node, c: string | undefined, info: Info): string | undefined {
  const caption = buildCaption(t, info);
  const above = nonNil(info["ascii-caption-above"]);
  const body = t.p.type === "org" ? c : removeIndentation(t.p.value ?? "");
  return justifyElement((caption && above ? caption + "\n" : "") + (body ?? "") + (!above && caption ? caption : ""), t, info);
}

function tableCellWidthOf(cell: Node, info: Info): number {
  const row = cell.parent!;
  const tbl = row.parent!;
  const col = row.contents.indexOf(cell);
  let cache: Map<Node, Map<number, number>> = info["ascii-table-cell-width-cache"];
  if (!cache) {
    cache = new Map();
    info["ascii-table-cell-width-cache"] = cache;
  }
  let widths = cache.get(tbl);
  if (!widths) {
    widths = new Map();
    cache.set(tbl, widths);
  }
  const cached = widths.get(col);
  if (cached !== undefined) return cached;
  const widen = nonNil(info["ascii-table-widen-columns"]);
  const cookie = tableCellWidth(cell, info);
  let width: number;
  if (!widen && cookie !== undefined) width = cookie;
  else {
    let max = 0;
    map(
      tbl,
      "table-row",
      (r) => {
        max = Math.max(stringWidth(data(contents(contents(r)[col]), info)), max);
        return undefined;
      },
      mapOpts(info),
    );
    width = cookie === undefined ? max : widen ? Math.max(cookie, max) : cookie;
  }
  widths.set(col, width);
  return width;
}

function tableCell(cell: Node, c: string | undefined, info: Info): string {
  const width = tableCellWidthOf(cell, info);
  let text = c;
  if (!(nonNil(info["ascii-table-widen-columns"]) || stringWidth(text ?? "") <= width)) text = (text ?? "").slice(0, width - 2) + "=>";
  const justified = text !== undefined ? justifyLines(text, width, tableCellAlignment(cell, info)) : undefined;
  text = (justified ?? "") + " ".repeat(Math.max(0, width - stringWidth(justified ?? "")));
  return ` ${text} ` + (tableCellBorders(cell, info).includes("right") ? (info["ascii-charset"] === "utf-8" ? "│" : "|") : "");
}

function tableRow(row: Node, c: string | undefined, info: Info): string | undefined {
  if (row.p.type !== "standard") return undefined;
  const cells = map(row, "table-cell", (x) => x as Node, mapOpts(info));
  const firstCell = cells[0];
  const buildHline = (lcorner: string, horiz: string, vert: string, rcorner: string) =>
    cells
      .map((cell) => {
        const width = tableCellWidthOf(cell, info);
        const borders = tableCellBorders(cell, info);
        return (
          (borders.includes("left") && firstCell === cell ? lcorner : "") +
          horiz.repeat(width + 2) +
          (!borders.includes("right") ? "" : row.contents[row.contents.length - 1] === cell ? rcorner : vert)
        );
      })
      .join("") + "\n";
  const utf8 = info["ascii-charset"] === "utf-8";
  const borders = firstCell ? tableCellBorders(firstCell, info) : [];
  let out = "";
  if (borders.includes("top") && (utf8 || borders.includes("above"))) out += utf8 ? buildHline("┍", "━", "┯", "┑") : buildHline("+", "-", "+", "+");
  else if (borders.includes("above")) out += utf8 ? buildHline("├", "─", "┼", "┤") : buildHline("+", "-", "+", "+");
  if (borders.includes("left")) out += utf8 ? "│" : "|";
  out += (c ?? "") + "\n";
  if (borders.includes("bottom") && (utf8 || borders.includes("below"))) out += utf8 ? buildHline("┕", "━", "┷", "┙") : buildHline("+", "-", "+", "+");
  return out;
}

function formatInlinetaskDefault(_todo: any, _type: any, _priority: any, _name: any, _tags: any, c: string | undefined, width: number | undefined, inlinetask: Node, info: Info): string | undefined {
  const utf8 = info["ascii-charset"] === "utf-8";
  const w = width ?? info["ascii-inlinetask-width"];
  const title = buildTitle(inlinetask, info, w);
  return indentLines(
    (utf8 ? "━" : "_").repeat(w) +
      "\n" +
      (utf8 ? "" : " ".repeat(w) + "\n") +
      (stringWidth(title) <= w ? title : fillString(title, w, info)) +
      "\n" +
      (nw(c) ? (utf8 ? "─" : "-").repeat(w) + "\n" + c : "") +
      (utf8 ? "━" : "_").repeat(w),
    info["ascii-text-width"] - info["ascii-global-margin"] - (ancestor(inlinetask, ["headline"]) ? info["ascii-inner-margin"] : 0) - currentTextWidth(inlinetask, info),
  );
}

function inlinetask(t: Node, c: string | undefined, info: Info): string | undefined {
  const width = currentTextWidth(t, info);
  const fn = info["ascii-format-inlinetask-function"];
  const args = [
    nonNil(info["with-todo-keywords"]) && t.p["todo-keyword"] ? data(t.p["todo-keyword"], info) : undefined,
    t.p["todo-type"],
    nonNil(info["with-priority"]) ? t.p.priority : undefined,
    data(t.p.title, info),
    nonNil(info["with-tags"]) ? t.p.tags : undefined,
    c,
    width,
    t,
    info,
  ] as const;
  if (nonNil(fn) && fn !== "org-ascii-format-inlinetask-default") return e8.funcall(fn, ...args);
  return formatInlinetaskDefault(...args);
}

const verbatimFormat = (info: Info, value: string) => String(info["ascii-verbatim-format"]).replace("%s", value);

defineBackend(
  "ascii",
  {
    bold: (_b, c) => `*${c}*`,
    "center-block": (_b, c) => c,
    clock: (clock: Node, _c, info) =>
      justifyElement(
        String(varValue("org-clock-string") || "CLOCK:") +
          " " +
          timestampTranslate(clock.p.value) +
          (clock.p.duration ? " => " + clock.p.duration.split(":").map((p: string, i: number) => (i === 0 ? p.padStart(2) : p.padStart(2, "0"))).join(":") : ""),
        clock,
        info,
      ),
    code: (code: Node, _c, info) => verbatimFormat(info, code.p.value),
    drawer: (drawer: Node, c, info) => {
      const fn = info["ascii-format-drawer-function"];
      return nonNil(fn) ? e8.funcall(fn, drawer.p["drawer-name"], c ?? null, currentTextWidth(drawer, info)) : c;
    },
    "dynamic-block": (_b, c) => c,
    entity: (entity: Node, _c, info) => entity.p[String(info["ascii-charset"])],
    "example-block": (b: Node, _c, info) => justifyElement(boxString(formatCodeDefault(b, info), info), b, info),
    "export-block": (b: Node, _c, info) => (b.p.type === "ASCII" ? justifyElement(b.p.value, b, info) : undefined),
    "export-snippet": (s: Node) => (snippetBackend(s) === "ascii" ? s.p.value : undefined),
    "fixed-width": (f: Node, _c, info) => justifyElement(boxString(removeIndentation(f.p.value ?? ""), info), f, info),
    "footnote-reference": (f: Node, _c, info) => `[${getFootnoteNumber(f, info)}]`,
    headline,
    "horizontal-rule": (hr: Node, _c, info) => {
      const width = currentTextWidth(hr, info);
      const spec = readAttribute("attr_ascii", hr, ":width");
      return justifyLines((info["ascii-charset"] === "utf-8" ? "―" : "-").repeat(spec && /^[0-9]+$/.test(spec) ? parseInt(spec, 10) : width), width, "center");
    },
    "inline-src-block": (b: Node, _c, info) => verbatimFormat(info, b.p.value),
    inlinetask,
    "inner-template": innerTemplate as any,
    italic: (_b, c) => `/${c}/`,
    item,
    keyword,
    "latex-environment": (env: Node, _c, info) => (nonNil(info["with-latex"]) ? justifyElement(removeIndentation(env.p.value ?? ""), env, info) : undefined),
    "latex-fragment": (f: Node, _c, info) => (nonNil(info["with-latex"]) ? f.p.value : undefined),
    "line-break": () => HARD_NEWLINE,
    link,
    "node-property": (np: Node) => `${np.p.key}:${np.p.value !== undefined ? " " + np.p.value : ""}`,
    paragraph,
    "plain-list": (pl: Node, c, info) => {
      const margin = info["ascii-list-margin"];
      return margin < 1 || pl.parent?.type === "item" ? c : indentLines(c, margin);
    },
    "plain-text": plainText as any,
    planning: (p: Node, _c, info) =>
      justifyElement(
        [
          p.p.closed ? `${varValue("org-closed-string") || "CLOSED:"} ${timestampTranslate(p.p.closed)}` : undefined,
          p.p.deadline ? `${varValue("org-deadline-string") || "DEADLINE:"} ${timestampTranslate(p.p.deadline)}` : undefined,
          p.p.scheduled ? `${varValue("org-scheduled-string") || "SCHEDULED:"} ${timestampTranslate(p.p.scheduled)}` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
        p,
        info,
      ),
    "property-drawer": (d: Node, c, info) => (nw(c) ? justifyElement(c, d, info) : undefined),
    "quote-block": (_b, c, info) => indentLines(c, info["ascii-quote-margin"]),
    "radio-target": (_r, c) => c,
    section,
    "special-block": (_b, c) => c,
    "src-block": srcBlock,
    "statistics-cookie": (s: Node) => s.p.value,
    "strike-through": (_b, c) => `+${c}+`,
    subscript: (s: Node, c) => (nonNil(s.p["use-brackets-p"]) ? `_{${c}}` : `_${c}`),
    superscript: (s: Node, c) => (nonNil(s.p["use-brackets-p"]) ? `^{${c}}` : `^${c}`),
    table,
    "table-cell": tableCell,
    "table-row": tableRow,
    target: () => undefined,
    template: template as any,
    timestamp: (ts: Node, _c, info) => plainText(timestampTranslate(ts), info),
    underline: (_b, c) => `_${c}_`,
    verbatim: (v: Node, _c, info) => verbatimFormat(info, v.p.value),
    "verse-block": (v: Node, c, info) => indentLines(justifyElement(c, v, info), info["ascii-quote-margin"]),
  },
  {
    menu: [
      "t",
      "Export to Plain Text",
      [
        ["A", "As ASCII buffer", (a, s, v, b) => exportAsAscii(a, s, v, b, { "ascii-charset": "ascii" })],
        ["a", "As ASCII file", (a, s, v, b) => exportToAscii(a, s, v, b, { "ascii-charset": "ascii" })],
        ["L", "As Latin1 buffer", (a, s, v, b) => exportAsAscii(a, s, v, b, { "ascii-charset": "latin1" })],
        ["l", "As Latin1 file", (a, s, v, b) => exportToAscii(a, s, v, b, { "ascii-charset": "latin1" })],
        ["U", "As UTF-8 buffer", (a, s, v, b) => exportAsAscii(a, s, v, b, { "ascii-charset": "utf-8" })],
        ["u", "As UTF-8 file", (a, s, v, b) => exportToAscii(a, s, v, b, { "ascii-charset": "utf-8" })],
      ],
    ],
    filters: {
      "filter-headline": headlineBlankLines,
      "filter-parse-tree": [paragraphSpacing, commentSpacing],
      "filter-section": headlineBlankLines,
      "filter-final-output": (s: string) => {
        killFillBuffer();
        return typeof s === "string" && s.includes(HARD) ? s.split(HARD).join("") : undefined;
      },
    },
    options: [
      ["subtitle", "SUBTITLE", undefined, undefined, "parse"],
      ["ascii-bullets", undefined, undefined, "org-ascii-bullets"],
      ["ascii-caption-above", undefined, undefined, "org-ascii-caption-above"],
      ["ascii-charset", undefined, undefined, "org-ascii-charset"],
      ["ascii-global-margin", undefined, undefined, "org-ascii-global-margin"],
      ["ascii-format-drawer-function", undefined, undefined, () => e8.variable("org-ascii-format-drawer-function")],
      ["ascii-format-inlinetask-function", undefined, undefined, () => e8.variable("org-ascii-format-inlinetask-function")],
      ["ascii-headline-spacing", undefined, undefined, "org-ascii-headline-spacing"],
      ["ascii-indented-line-width", undefined, undefined, "org-ascii-indented-line-width"],
      ["ascii-inlinetask-width", undefined, undefined, "org-ascii-inlinetask-width"],
      ["ascii-inner-margin", undefined, undefined, "org-ascii-inner-margin"],
      ["ascii-links-to-notes", undefined, undefined, "org-ascii-links-to-notes"],
      ["ascii-list-margin", undefined, undefined, "org-ascii-list-margin"],
      ["ascii-paragraph-spacing", undefined, undefined, "org-ascii-paragraph-spacing"],
      ["ascii-quote-margin", undefined, undefined, "org-ascii-quote-margin"],
      ["ascii-table-keep-all-vertical-lines", undefined, undefined, "org-ascii-table-keep-all-vertical-lines"],
      ["ascii-table-use-ascii-art", undefined, undefined, "org-ascii-table-use-ascii-art"],
      ["ascii-table-widen-columns", undefined, undefined, "org-ascii-table-widen-columns"],
      ["ascii-text-width", undefined, undefined, "org-ascii-text-width"],
      ["ascii-underline", undefined, undefined, "org-ascii-underline"],
      ["ascii-verbatim-format", undefined, undefined, "org-ascii-verbatim-format"],
    ],
  },
);

// --- Filters -----------------------------------------------------------------------

function headlineBlankLines(headline: string, _backend: string | undefined, info: Info): string | undefined {
  const spacing = info["ascii-headline-spacing"];
  if (!Array.isArray(spacing)) return headline;
  return headline.replace(/\n(?:\n[ \t]*)*$/, "\n".repeat(spacing[1] + 1));
}

function paragraphSpacing(tree: Node, _backend: string | undefined, info: Info): Node {
  const spacing = info["ascii-paragraph-spacing"];
  if (typeof spacing === "number" && Number.isInteger(spacing) && spacing >= 0)
    map(
      tree,
      "paragraph",
      (p) => {
        if (typeOf(getNextElement(p, info)) === "paragraph") (p as Node).p["post-blank"] = spacing;
        return undefined;
      },
      mapOpts(info),
    );
  return tree;
}

function commentSpacing(tree: Node, _backend: string | undefined, info: Info): Node {
  map(tree, ["comment", "comment-block"], (c) => {
    const next = typeOf(getNextElement(c, info));
    if (next === "comment" || next === "comment-block") (c as Node).p["post-blank"] = 0;
    return undefined;
  });
  return tree;
}

// --- Commands ------------------------------------------------------------------------

function extOf(v: unknown): Info {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Info) : {};
}

function exportAsAscii(_async: unknown, subtreep: unknown, visibleOnly: unknown, bodyOnly: unknown, ext: unknown): void {
  toBuffer("ascii", "*Org ASCII Export*", flag(subtreep), flag(visibleOnly), flag(bodyOnly), extOf(ext), () => e8.call("text-mode"));
}

function exportToAscii(_async: unknown, subtreep: unknown, visibleOnly: unknown, bodyOnly: unknown, ext: unknown): string {
  const file = outputFileName(".txt", flag(subtreep));
  return toFile("ascii", file, flag(subtreep), flag(visibleOnly), flag(bodyOnly), extOf(ext));
}

e8.defineCommand({
  name: "org-ascii-export-as-ascii",
  doc: "Export current buffer to a text buffer, *Org ASCII Export*, in the character set org-ascii-charset names.",
  params: EXPORT_PARAMS,
  run: exportAsAscii,
});

e8.defineCommand({
  name: "org-ascii-export-to-ascii",
  doc: "Export current buffer to a text file, named after the buffer's with .txt.",
  params: EXPORT_PARAMS,
  run: (a: unknown, s: unknown, v: unknown, b: unknown, x: unknown) => {
    exportToAscii(a, s, v, b, x);
  },
});

function convertRegion(charset: string): void {
  const mark = e8.mark();
  if (!e8.variable("mark-active") || mark === undefined) e8.userError("No active region to replace");
  const from = Math.min(e8.point(), mark);
  const to = Math.max(e8.point(), mark);
  const text = e8.deleteRegion(from, to);
  e8.gotoChar(from);
  e8.insert(stringAs(text, "ascii", true, { "ascii-charset": charset }));
}

e8.defineCommand({
  name: "org-ascii-convert-region-to-ascii",
  doc: "Assume region has Org syntax, and convert it to plain ASCII.",
  run: () => convertRegion("ascii"),
});

e8.defineCommand({
  name: "org-ascii-convert-region-to-utf8",
  doc: "Assume region has Org syntax, and convert it to UTF-8.",
  run: () => convertRegion("utf-8"),
});

void getPreviousElement;
