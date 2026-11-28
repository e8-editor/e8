// Org's Org export backend, after ox-org.el: the document written back
// as Org syntax, with the export's options applied (TODO keywords, tags,
// priorities, levels), macros and #+INCLUDE expanded and the options'
// keywords gathered at the top. Publishing uses it to publish Org files
// as they are, with org-org-publish-to-org, and org-list-to-generic writes
// lists through it, as Org's does.

import { ALL_OBJECTS, type Datum, type Node, adoptElements, create, insertBefore, lineage, map, putProperty, replace, typeOf } from "org-element-ast";
import { interpretData, interpretNode, normalizeString, parseBuffer } from "org-element";
import { EXPORT_PARAMS } from "org-loaddefs";
import { findBufferVisiting } from "files";
import { htmlizeBuffer } from "htmlize";
import { charCount } from "subr";
import {
  type Backend,
  type Info,
  createBackend,
  customProtocolMaybe,
  data,
  dataWithBackend,
  defineBackend,
  expand,
  flag,
  footnoteFirstReferenceP,
  getDate,
  getBackend,
  getEnvironment,
  getFootnoteDefinition,
  getNextElement,
  getRelativeLevel,
  mapOpts,
  nonNil,
  outputFileName,
  timestampTranslate,
  toBuffer,
  toFile,
  varValue,
  withBackend,
} from "ox";

e8.defineVariable({
  name: "org-org-htmlized-css-url",
  value: null,
  doc: "URL pointing to the CSS defining colors for htmlized Org sources, which publishing with :htmlized-source links to in place of the style sheet htmlize writes; nil keeps htmlize's.",
});
e8.defineVariable({ name: "org-org-with-special-rows", value: true, doc: "Non-nil means export special table rows." });
e8.defineVariable({ name: "org-org-with-cite-processors", value: false, doc: "Non-nil means use citation processors when exporting citations." });

const nw = (s: unknown): s is string => typeof s === "string" && /\S/.test(s);

/** A datum written back as Org syntax, without its #+attr_ lines, as org-org-identity. */
function identity(blob: Node, contents: string | undefined): string {
  return expand(blob, contents, true).replace(/^[ \t]*#\+attr_[-_a-z0-9]+:(?: .*)?\n/gim, "");
}

function headline(h: Node, contents: string | undefined, info: Info): string | undefined {
  if (h.p["footnote-section-p"]) return undefined;
  if (!nonNil(info["with-todo-keywords"])) putProperty(h, "todo-keyword", undefined);
  if (!nonNil(info["with-tags"])) putProperty(h, "tags", undefined);
  if (!nonNil(info["with-priority"])) putProperty(h, "priority", undefined);
  putProperty(h, "level", getRelativeLevel(h, info));
  return interpretNode(h, contents);
}

function keyword(k: Node): string | undefined {
  return ["AUTHOR", "CREATOR", "DATE", "EMAIL", "OPTIONS", "TITLE"].includes(k.p.key) ? undefined : interpretNode(k, undefined);
}

function link(l: Node, contents: string | undefined, info: Info): string {
  return customProtocolMaybe(l, contents, "org", info) ?? interpretNode(l, contents);
}

function template(contents: string, info: Info): string {
  const options = map(info["parse-tree"], "keyword", (k) => ((k as Node).p.key === "OPTIONS" ? "#+options: " + (k as Node).p.value : undefined));
  let out = "";
  if (nonNil(info["time-stamp-file"])) out += e8.formatTimeString("# Created %Y-%m-%d %a %H:%M\n");
  out += normalizeString(options.join("\n"));
  if (nonNil(info["with-title"])) out += `#+title: ${data(info["title"], info)}\n`;
  if (nonNil(info["with-date"])) {
    const date = data(getDate(info), info);
    if (nw(date)) out += `#+date: ${date}\n`;
  }
  if (nonNil(info["with-author"])) {
    const author = data(info["author"], info);
    if (nw(author)) out += `#+author: ${author}\n`;
  }
  if (nonNil(info["with-email"])) {
    const email = data(info["email"], info);
    if (nw(email)) out += `#+email: ${email}\n`;
  }
  if (nonNil(info["with-creator"]) && nw(info["creator"])) out += `#+creator: ${info["creator"]}\n`;
  return out + contents;
}

function section(s: Node, contents: string | undefined, info: Info): string {
  const up = lineage(s, ["headline"])[0];
  const footnotes = map(
    // Before the first heading, none: Org maps over (nil SECTION), which it does not walk.
    up ? [up, s] : [],
    "footnote-reference",
    (fn) => {
      const f = fn as Node;
      if (f.p.type !== "standard" || !footnoteFirstReferenceP(f, info)) return undefined;
      return normalizeString(`[fn:${f.p.label}] ${data(getFootnoteDefinition(f, info), info)}`);
    },
    mapOpts(info, { noRecursion: ["headline"], withAffiliated: true }),
  );
  return normalizeString(contents ?? "") + (footnotes.length ? "\n" + footnotes.join("\n") : "");
}

/** Gives each headline a section, which footnotes are written into, as org-org--add-missing-sections. */
function addMissingSections(tree: Node): Node {
  map(tree, "headline", (h) => {
    const first = (h as Node).contents[0];
    const neu = create("section");
    if (first === undefined) adoptElements(h as Node, neu);
    else if (typeOf(first) !== "section") insertBefore(neu, first);
    return undefined;
  });
  return tree;
}

const ID = (b: Node, c: string | undefined) => identity(b, c);

defineBackend(
  "org",
  {
    "babel-call": ID,
    bold: ID,
    "center-block": ID,
    clock: ID,
    code: ID,
    "diary-sexp": ID,
    drawer: ID,
    "dynamic-block": ID,
    entity: ID,
    "example-block": ID,
    "export-block": (b: Node) => (b.p.type === "ORG" ? b.p.value : undefined),
    "fixed-width": ID,
    "footnote-definition": () => undefined,
    "footnote-reference": ID,
    headline,
    "horizontal-rule": ID,
    "inline-babel-call": ID,
    "inline-src-block": ID,
    inlinetask: ID,
    italic: ID,
    citation: ID,
    "citation-reference": ID,
    item: ID,
    keyword,
    "latex-environment": ID,
    "latex-fragment": ID,
    "line-break": ID,
    link,
    "node-property": ID,
    template,
    paragraph: ID,
    "plain-list": ID,
    planning: ID,
    "property-drawer": ID,
    "quote-block": ID,
    "radio-target": ID,
    section,
    "special-block": ID,
    "src-block": ID,
    "statistics-cookie": ID,
    "strike-through": ID,
    subscript: ID,
    superscript: ID,
    table: ID,
    "table-cell": ID,
    "table-row": ID,
    target: ID,
    timestamp: (ts: Node) => timestampTranslate(ts),
    underline: ID,
    verbatim: ID,
    "verse-block": ID,
  },
  {
    menu: [
      "O",
      "Export to Org",
      [
        ["O", "As Org buffer", (a: boolean, s: boolean, v: boolean, b: boolean) => exportAsOrg(a, s, v, b)],
        ["o", "As Org file", (a: boolean, s: boolean, v: boolean, b: boolean) => exportToOrg(a, s, v, b)],
        ["v", "As Org file and open", (a: boolean, s: boolean, v: boolean, b: boolean) => e8.call("find-file", exportToOrg(a, s, v, b))],
      ],
    ],
    filters: { "filter-parse-tree": (tree: Node) => addMissingSections(tree) },
    options: [
      ["with-special-rows", undefined, undefined, "org-org-with-special-rows"],
      ["with-cite-processors", undefined, undefined, "org-org-with-cite-processors"],
    ],
  },
);

export function exportAsOrg(_async?: unknown, subtreep?: unknown, visibleOnly?: unknown, bodyOnly?: unknown, extPlist?: unknown): string {
  return toBuffer("org", "*Org ORG Export*", flag(subtreep), flag(visibleOnly), flag(bodyOnly), (extPlist as Info) || {}, () => e8.call("org-mode"));
}

export function exportToOrg(_async?: unknown, subtreep?: unknown, visibleOnly?: unknown, bodyOnly?: unknown, extPlist?: unknown): string {
  const file = outputFileName(".org", flag(subtreep));
  return toFile("org", file, flag(subtreep), flag(visibleOnly), flag(bodyOnly), (extPlist as Info) || {});
}

e8.defineCommand({
  name: "org-org-export-as-org",
  doc: "Export current buffer to an Org buffer, *Org ORG Export*.\n\nWith SUBTREEP, export the subtree at point; with VISIBLE-ONLY, only visible text; with BODY-ONLY, without the document's keywords.",
  params: EXPORT_PARAMS,
  run: (a, s, v, b, x) => {
    exportAsOrg(a, s, v, b, x);
  },
});

e8.defineCommand({
  name: "org-org-export-to-org",
  doc: "Export current buffer to an Org file, named after the buffer's file with .org; return its name.",
  params: EXPORT_PARAMS,
  run: (a, s, v, b, x) => {
    exportToOrg(a, s, v, b, x);
  },
});

// --- Lists as Lisp data, written in another syntax -------------------------------
//
// A list as org-list-to-lisp gives it: its type, "unordered", "ordered"
// or "descriptive", then its items, each a list of strings and the lists
// under it: ["unordered", ["one"], ["two", ["ordered", ["2a"]]]]. Symbols
// may stand for the types, as e8.intern("unordered").

/** A list's parameters, as a property list's keys without the colon: istart, icount, ifmt, isep, cbon and the rest. */
export type ListParams = { [key: string]: any };

const name = (v: unknown) => (typeof v === "symbol" ? e8.symbolName(v) : v);

/** A parameter's value: a string, or what a function returns, as org-list--generic-eval. */
function generic(value: any, ...args: any[]): string | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "function" || typeof value === "symbol") {
    const r = e8.funcall(typeof value === "symbol" ? e8.symbolName(value) : value, ...args);
    return r === null || r === undefined || r === false ? undefined : String(r);
  }
  e8.signal("error", `Wrong value: ${String(value)}`);
}

function depth(d: Datum): number {
  return lineage(d, ["plain-list"], true as any).filter((x) => typeOf(x) === "plain-list").length;
}

/** The lines after the line a string's text ends on, as org-list--trailing-newlines. */
function trailingNewlines(s: string): number {
  const at = s.replace(/[ \t\n]*$/, "").length;
  const nl = s.indexOf("\n", at);
  if (nl < 0) return 0;
  const rest = s.slice(nl + 1);
  return (rest.match(/\n/g)?.length ?? 0) + (rest !== "" && !rest.endsWith("\n") ? 1 : 0);
}

function plainListTranscoder(params: ListParams) {
  return (list: Node, contents: string | undefined, info: Info): string => {
    const type = list.p.type;
    const d = depth(list);
    const splice = nonNil(params.splice);
    const start = splice ? undefined : generic(type === "ordered" ? params.ostart : type === "unordered" ? params.ustart : params.dstart, d);
    const end = splice ? undefined : generic(type === "ordered" ? params.oend : type === "unordered" ? params.uend : params.dend, d);
    if (end !== undefined) putProperty(list, "post-blank", trailingNewlines(end));
    const body = start !== undefined || end !== undefined || splice || !params.backend ? (contents ?? "") : (withBackend(params.backend, list, contents, info) ?? "");
    return (start !== undefined ? start + "\n" : "") + body + (end ?? "");
  };
}

function itemTranscoder(params: ListParams) {
  return (item: Node, contents: string | undefined, info: Info): string => {
    const type = item.parent?.p.type;
    const tag = item.p.tag;
    const d = depth(item);
    const separator = getNextElement(item, info) ? generic(params.isep, type, d) : undefined;
    const iend = generic(params.iend, type, d);
    const closing = iend === undefined || iend === "" ? "\n" : separator !== undefined ? (iend.endsWith("\n") ? iend : iend + "\n") : iend;
    const last = separator ?? closing;
    if (last !== undefined) putProperty(item, "post-blank", Math.max(trailingNewlines(last) - 1, 0));
    const c = item.p.counter;
    const head = c != null && params.icount ? generic(params.icount, type, d, c) : generic(params.istart, type, d);
    let body: string;
    if (params.istart || params.iend || params.icount || params.ifmt || params.cbon || params.cboff || params.cbtrans || !params.backend || (type === "descriptive" && (params.dtstart || params.dtend || params.ddstart || params.ddend))) {
      const box = name(item.p.checkbox);
      const inner = contents === undefined || contents.length === 0 ? "" : contents.slice(0, -1);
      body =
        (box === "on" ? (params.cbon ?? "") : box === "off" ? (params.cboff ?? "") : box === "trans" ? (params.cbtrans ?? "") : "") +
        (tag ? (params.dtstart ?? "") + (params.backend ? dataWithBackend(tag, params.backend, info) : interpretData(tag)) + (params.dtend ?? "") : "") +
        (tag ? (params.ddstart ?? "") : "") +
        (params.ifmt ? (generic(params.ifmt, type, inner) ?? "") : inner) +
        (tag ? (params.ddend ?? "") : "");
    } else body = withBackend(params.backend, item, contents, info) ?? "";
    return (head ?? "") + (body === "" ? "" : normalizeString(body).slice(0, -1)) + closing + (separator ?? "");
  };
}

/**
 * A list as Lisp data written with PARAMS, as org-list-to-generic: the
 * list is written as Org, parsed, and exported with transcoders for lists
 * and items made from PARAMS over the backend PARAMS.backend names, or
 * Org's.
 */
export function listToGeneric(list: any[], params: ListParams = {}): string {
  const backendName: string | undefined = name(params.backend) as any;
  const custom: Backend = createBackend({
    parent: backendName ?? "org",
    transcoders: {
      "plain-list": plainListTranscoder({ ...params, backend: backendName }),
      item: itemTranscoder({ ...params, backend: backendName }),
      macro: (m: Node) => interpretNode(m, undefined),
    },
  });
  const buffer = e8.generateNewBufferName(" *Org list*");
  e8.getBufferCreate(buffer);
  try {
    return e8.withCurrentBuffer(buffer, () => {
      e8.letBind({ "org-inhibit-startup": true }, () => e8.call("org-mode"));
      const insertList = (l: any[]) => {
        const type = name(l[0]);
        for (const i of l.slice(1)) insertItem(i, type as string);
      };
      const insertItem = (i: any[], type: string) => {
        const start = e8.point();
        e8.insert(type === "ordered" ? "1. " : "- ");
        for (const e of i) {
          if (Array.isArray(e)) insertList(e);
          else {
            e8.insert(String(e));
            e8.insert("\n");
          }
        }
        e8.gotoChar(e8.lineStart(e8.lineOf(e8.point())));
        e8.saveExcursion(() => {
          const ind = type === "ordered" ? 3 : 2;
          while (e8.point() > start) {
            if (!e8.lookingAt("[ \t]*$")) e8.indentTo(ind);
            e8.gotoChar(e8.lineStart(e8.lineOf(e8.point()) - 1));
          }
        });
      };
      insertList(list);
      const tree = parseBuffer();
      const found = map(tree, "plain-list", (x) => x, { firstMatch: true })[0] as Node | undefined;
      if (backendName && !getBackend(backendName)) e8.userError("Unknown :backend value");
      const info = getEnvironment(backendName, false, params);
      if (backendName && nonNil(params.raw) && found) for (const o of map(found, ALL_OBJECTS, (x) => x)) replace(o, interpretData(o));
      const output = found ? dataWithBackend(found, custom, info) : "";
      return nw(output) ? output.slice(0, -1) : "";
    });
  } finally {
    e8.call("kill-buffer", buffer);
  }
}

/** A list as Lisp data written as an Org plain list, as org-list-to-org. */
export function listToOrg(list: any[], params: ListParams = {}): string {
  const makeItem = (type: unknown, _depth: number, c?: number) => (name(type) === "ordered" ? "1. " : "- ") + (c != null ? `[@${c}] ` : "");
  return listToGeneric(list, {
    istart: makeItem,
    icount: makeItem,
    ifmt: (_type: unknown, contents: string) => contents.replace(/\n/g, "\n  "),
    dtend: " :: ",
    cbon: "[X] ",
    cboff: "[ ] ",
    cbtrans: "[-] ",
    ...params,
  });
}

/** A list as Lisp data written as a subtree of headings, from START-LEVEL, as org-list-to-subtree. */
export function listToSubtree(list: any[], startLevel?: number, params: ListParams = {}): string {
  const blankSetting = (varValue("org-blank-before-new-entry") as any[] | undefined)?.find?.((e: any) => Array.isArray(e) && name(e[0]) === "heading")?.[1];
  const blank = blankSetting === true;
  const level = startLevel ?? 1;
  const odd = nonNil(varValue("org-odd-levels-only"));
  const makeStars = (_type: unknown, d: number) => {
    const l = level + (d - 1);
    return "*".repeat(odd ? 2 * l - 1 : l) + " ";
  };
  return listToGeneric(list, {
    splice: true,
    istart: makeStars,
    icount: makeStars,
    dtstart: " ",
    dtend: " ",
    isep: blank ? "\n\n" : "\n",
    cbon: "DONE ",
    cboff: "TODO ",
    cbtrans: "TODO ",
    ...params,
  });
}

e8.defun("org-list-to-generic", (list: any[], params?: ListParams) => listToGeneric(list, params));
e8.defun("org-list-to-org", (list: any[], params?: ListParams) => listToOrg(list, params));
e8.defun("org-list-to-subtree", (list: any[], startLevel?: number, params?: ListParams) => listToSubtree(list, startLevel, params));

/** A project's property, from its plist of :keyword and value. */
function plistValue(plist: e8.Value[], key: string): any {
  for (let i = 0; i + 1 < plist.length; i += 2) if (plist[i] === key || (typeof plist[i] === "symbol" && e8.symbolName(plist[i] as symbol) === key)) return plist[i + 1];
  return undefined;
}

/**
 * The Org file, fontified and unfolded, as HTML in htmlize's css output,
 * written to PUB-DIR as the file's name with the HTML extension, as
 * org-org-publish-to-org does for :htmlized-source.
 */
function publishHtmlizedSource(plist: e8.Value[], filename: string, pubDir: string): void {
  e8.require("ox-html");
  const projectExt = plistValue(plist, ":html-extension");
  const htmlExt = "." + (nonNil(projectExt) ? String(projectExt) : nonNil(varValue("org-html-extension")) ? String(varValue("org-html-extension")) : "html");
  const html = e8.letBind({ "org-inhibit-startup": true, "htmlize-output-type": e8.intern("css") }, () => {
    const existing = findBufferVisiting(filename);
    const buffer = existing ?? e8.findFileNoselect(filename);
    try {
      return e8.withCurrentBuffer(buffer, () => {
        e8.call("font-lock-ensure");
        e8.call("org-show-all" as e8.CommandName);
        return htmlizeBuffer();
      });
    } finally {
      if (!existing && e8.getBuffer(buffer)) e8.call("kill-buffer", buffer);
    }
  });
  try {
    e8.withCurrentBuffer(html, () => {
      const url = varValue("org-org-htmlized-css-url");
      if (nonNil(url)) {
        const text = e8.bufferText();
        const m = /<style type="text\/css">[\s\S]*?\n[ \t]*<\/style>.*/.exec(text);
        if (m) {
          const start = charCount(text.slice(0, m.index));
          e8.deleteRegion(start, start + charCount(m[0]));
          e8.gotoChar(start);
          e8.insert(`<link rel="stylesheet" type="text/css" href="${url}">`);
        }
      }
      e8.writeRegion(null, null, pubDir + e8.fileNameNondirectory(filename) + htmlExt, { quiet: true });
    });
  } finally {
    e8.call("kill-buffer", html);
  }
}

/** Publish an Org file as Org, as org-org-publish-to-org, and with :htmlized-source as HTML beside it; nil, as Org's returns, for the after-publishing hook. */
e8.defun("org-org-publish-to-org", (plist: e8.Value[], filename: string, pubDir: string) => {
  e8.funcall("org-publish-org-to", "org", filename, ".org", plist, pubDir);
  if (nonNil(plistValue(plist, ":htmlized-source"))) publishHtmlizedSource(plist, filename, pubDir);
  return null;
});
