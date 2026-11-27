// Org's Markdown export backend, after ox-md.el: the HTML backend's
// derivative that writes Markdown, as John Gruber's syntax has it, and
// falls back to HTML for what Markdown cannot say (tables, centered and
// special blocks, inline tasks).

import { ALL_ELEMENTS, type Datum, type Node, lineage, map, mapFirst, typeOf } from "org-element-ast";
import { EXPORT_PARAMS } from "org-loaddefs";
import { browseUrl } from "browse-url";
import { publishOrgTo } from "ox-publish";
import {
  type Info,
  activateSmartQuotes,
  collectFootnoteDefinitions,
  collectHeadlines,
  customProtocolMaybe,
  data,
  dataWithBackend,
  defineDerivedBackend,
  fileUri,
  firstSiblingP,
  flag,
  formatCodeDefault,
  getAltTitle,
  getCaption,
  getCoderefFormat,
  getHeadlineNumber,
  getNextElement,
  getOrdinal,
  getReference,
  getRelativeLevel,
  getTags,
  inlineImageP,
  itemNumber,
  lowLevelP,
  mapOpts,
  nonNil,
  numberedHeadlineP,
  outputFileName,
  removeIndentation,
  resolveCoderef,
  resolveFuzzyLink,
  resolveIdLink,
  resolveLink,
  resolveRadioLink,
  toBuffer,
  toFile,
  tocEntryBackend,
  varValue,
  withBackend,
} from "ox";
import { convertSpecialStrings, extPlistOf, format, htmlAnchor, reference, replaceRegionBy, translateHtml } from "ox-html";

const S = (name: string) => e8.intern(name);
const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });

defvar("org-md-footnote-format", "<sup>%s</sup>", "Format string for the footnote reference.");
defvar("org-md-footnotes-section", "%s%s", "Format string for the footnotes section.");
defvar("org-md-headline-style", S("atx"), "Style used to format headlines.");
defvar("org-md-toplevel-hlevel", 1, "Heading level to use for level 1 Org headings in markdown export.");

const nw = (s: unknown): s is string => typeof s === "string" && /\S/.test(s);
const trim = (s: string) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
const tagString = (tags: string[]) => (tags.length ? `:${tags.join(":")}:` : "");

/** Every element but items and rows separated by one blank line, as org-md-separate-elements: none after an item's first paragraph followed only by a sub-list. */
function separateElements(tree: any, _backend: string | undefined, info: Info): any {
  map(tree, ALL_ELEMENTS.filter((t) => t !== "item" && t !== "table-row"), (d) => {
    const e = d as Node;
    let blank = 1;
    if (e.type === "paragraph" && e.parent?.type === "item" && firstSiblingP(e, info)) {
      const next = getNextElement(e, info);
      if (typeOf(next) === "plain-list" && !getNextElement(next!, info)) blank = 0;
    }
    e.p["post-blank"] = blank;
    return undefined;
  });
  return tree;
}

/** Whether a heading is the target of a link or table of contents, so it needs an anchor, as org-md--headline-referred-p. */
function headlineReferredP(headline: Node, info: Info): boolean {
  if (nonNil(headline.p["footnote-section-p"])) return false;
  if (nonNil(info["with-toc"]) && collectHeadlines(info, info["with-toc"]).includes(headline)) return true;
  for (const h of lineage(headline)) {
    const section = h.contents[0];
    if (typeOf(section) !== "section") continue;
    const found = mapFirst(
      section,
      "keyword",
      (k) => {
        const kw = k as Node;
        if (kw.p.key !== "TOC") return undefined;
        const value = String(kw.p.value ?? "");
        if (!/\bheadlines\b/i.test(value)) return undefined;
        const d = /\b[0-9]+\b/.exec(value);
        const local = /\blocal\b/i.test(value);
        return collectHeadlines(info, d ? parseInt(d[0], 10) : undefined, local ? kw : undefined).includes(headline) || undefined;
      },
      mapOpts(info),
    );
    if (found) return true;
  }
  return nonNil(
    mapFirst(
      info["parse-tree"],
      "link",
      (l) => {
        try {
          return resolveIdLink(l as Node, info) === headline || undefined;
        } catch {
          return undefined;
        }
      },
      mapOpts(info),
    ),
  );
}

function headlineTitle(style: string, level: number, title: string, anchor?: string, tags?: string): string {
  const anchorLines = anchor ? anchor + "\n\n" : "";
  if ((style === "setext" || style === "mixed") && level < 3) {
    const underline = (level === 1 ? "=" : "-").repeat(title.length) + "\n";
    return "\n" + anchorLines + title + (tags ?? "") + "\n" + underline + "\n";
  }
  return "\n" + anchorLines + "#".repeat(level) + " " + title + (tags ?? "") + "\n\n";
}

function buildToc(info: Info, n?: number, _keyword?: Node, scope?: Datum): string {
  let out = "";
  if (!scope) out += headlineTitle(info["md-headline-style"], info["md-toplevel-hlevel"], translateHtml("Table of Contents", info));
  out += collectHeadlines(info, n, scope)
    .map((headline) => {
      const indentation = " ".repeat(4 * (getRelativeLevel(headline, info) - 1));
      let bullet = "-   ";
      if (numberedHeadlineP(headline, info)) {
        const numbers = getHeadlineNumber(headline, info)!;
        const prefix = `${numbers[numbers.length - 1]}.`;
        bullet = prefix + " ".repeat(Math.max(1, 4 - prefix.length));
      }
      const title = format("[%s](#%s)", dataWithBackend(getAltTitle(headline, info), tocEntryBackend("md"), info), headline.p.CUSTOM_ID ?? getReference(headline, info));
      const tags = nonNil(info["with-tags"]) && info["with-tags"] !== "not-in-toc" ? tagString(getTags(headline, info)) : "";
      return indentation + bullet + title + tags;
    })
    .join("\n");
  return out + "\n";
}

function footnoteSection(info: Info): string | undefined {
  const fns = collectFootnoteDefinitions(info).map(([n, , raw]) => [n, trim(data(raw as any, info))] as [number, string]);
  if (fns.length === 0) return undefined;
  const title = translateHtml("Footnotes", info);
  return format(
    info["md-footnotes-section"],
    headlineTitle(info["md-headline-style"], info["md-toplevel-hlevel"], title),
    fns.map(([n, text]) => format(info["md-footnote-format"], htmlAnchor(`fn.${n}`, String(n), ` href="#fnr.${n}"`, info)) + " " + text + "\n").join("\n"),
  );
}

const convertToHtml = (d: Node, _c: unknown, info: Info) => dataWithBackend(d, "html", info);
const identity = (_d: unknown, c: string | undefined) => c;

function verbatim(v: Node): string {
  const value: string = v.p.value;
  return format(!value.includes("`") ? "`%s`" : value.startsWith("`") || value.endsWith("`") ? "`` %s ``" : "``%s``", value);
}

function exampleBlock(b: Node, _c: unknown, info: Info): string {
  return removeIndentation(formatCodeDefault(b, info)).replace(/^/gm, "    ");
}

function headline(h: Node, contents: string | undefined, info: Info): string | undefined {
  if (nonNil(h.p["footnote-section-p"])) return undefined;
  const level = getRelativeLevel(h, info) + (info["md-toplevel-hlevel"] - 1);
  const title = data(h.p.title, info);
  const todo = nonNil(info["with-todo-keywords"]) && h.p["todo-keyword"] ? data(h.p["todo-keyword"], info) + " " : "";
  const tagList = nonNil(info["with-tags"]) ? getTags(h, info) : [];
  const tags = tagList.length ? "     " + tagString(tagList) : "";
  const pri = h.p.priority;
  const priority = nonNil(info["with-priority"]) && pri !== undefined && pri !== null ? `[#${typeof pri === "number" ? String.fromCodePoint(pri) : pri}] ` : "";
  const heading = todo + priority + title;
  const style: string = info["md-headline-style"];
  if (
    lowLevelP(h, info) !== undefined ||
    !["atx", "mixed", "setext"].includes(style) ||
    (style === "atx" && level > 6) ||
    (style === "setext" && level > 2) ||
    (style === "mixed" && level > 6)
  ) {
    let bullet = "-";
    if (numberedHeadlineP(h, info)) {
      const numbers = getHeadlineNumber(h, info)!;
      bullet = `${numbers[numbers.length - 1]}.`;
    }
    return bullet + " ".repeat(4 - bullet.length) + heading + tags + "\n\n" + (contents ? contents.replace(/^/gm, "    ") : "");
  }
  const anchor = headlineReferredP(h, info) ? format('<a id="%s"></a>', h.p.CUSTOM_ID ?? getReference(h, info)) : undefined;
  return headlineTitle(style, level, heading, anchor, tags) + (contents ?? "");
}

function item(i: Node, contents: string | undefined, info: Info): string {
  const type = i.parent!.p.type;
  let bullet = "-";
  if (type === "ordered") {
    const n = itemNumber(i);
    bullet = `${n[n.length - 1]}.`;
  }
  const cb = { on: "[X] ", trans: "[-] ", off: "[ ] " }[String(i.p.checkbox) as "on"] ?? "";
  const tag = i.p.tag ? format("**%s:** ", data(i.p.tag, info)) : "";
  return bullet + " ".repeat(Math.max(1, 4 - bullet.length)) + cb + tag + (contents ? trim(contents.replace(/^/gm, "    ")) : "");
}

function keyword(k: Node, contents: string | undefined, info: Info): string | undefined {
  const key = k.p.key;
  if (key === "MARKDOWN" || key === "MD") return k.p.value;
  if (key === "TOC") {
    const value = String(k.p.value ?? "");
    if (/\bheadlines\b/i.test(value)) {
      const d = /\b[0-9]+\b/.exec(value);
      const t = /:target +(".+?"|\S+)/i.exec(value);
      const scope = t ? (resolveLink(t[1].replace(/^"(.*)"$/, "$1"), info) as Datum) : /\blocal\b/i.test(value) ? k : undefined;
      return removeIndentation(buildToc(info, d ? parseInt(d[0], 10) : undefined, k, scope));
    }
    return undefined;
  }
  return withBackend("html", k, contents, info);
}

function latexEnvironment(env: Node, _c: unknown, info: Info): string | undefined {
  if (!nonNil(info["with-latex"])) return undefined;
  const frag = removeIndentation(env.p.value);
  const label = reference(env, info, true);
  return nw(label) ? frag.replace(/^.*/, (m) => `${m}\n\\label{${label}}`) : frag;
}

function latexFragment(f: Node, _c: unknown, info: Info): string | undefined {
  if (!nonNil(info["with-latex"])) return undefined;
  const frag: string = f.p.value;
  if (/^\\\(/.test(frag)) return "$" + frag.slice(2, -2) + "$";
  if (/^\\\[/.test(frag)) return "$$" + frag.slice(2, -2) + "$$";
  return frag;
}

function parentElement(d: Node): Node | undefined {
  let up = d.parent;
  while (up && !ALL_ELEMENTS.includes(up.type) && up.type !== "org-data") up = up.parent;
  return up;
}

function link(l: Node, desc: string | undefined, info: Info): string | undefined {
  const orgAsMd = (rawPath: string) => (/\.org$/i.test(rawPath) && !/\/\.org$/.test(rawPath) ? rawPath.replace(/\.[^./]*$/, "") + ".md" : rawPath);
  const type: string = l.p.type;
  const rawPath: string = l.p.path;
  const path = type === "file" ? fileUri(orgAsMd(rawPath)) : type + ":" + rawPath;
  const custom = customProtocolMaybe(l, desc, "md", info);
  if (custom !== undefined) return custom;
  if (type === "custom-id" || type === "id" || type === "fuzzy") {
    const destination = type === "fuzzy" ? resolveFuzzyLink(l, info) : resolveIdLink(l, info);
    if (typeof destination === "string") {
      const p = orgAsMd(destination);
      return !desc ? `<${p}>` : `[${desc}](${p})`;
    }
    if (typeOf(destination) === "headline") {
      const dest = destination as Node;
      const text = nw(desc) ? desc : numberedHeadlineP(dest, info) ? getHeadlineNumber(dest, info)!.join(".") : data(dest.p.title, info);
      return format("[%s](#%s)", text, dest.p.CUSTOM_ID ?? getReference(dest, info));
    }
    let description: string | undefined = nw(desc) ? desc : undefined;
    if (!description) {
      const number = getOrdinal(destination, info);
      if (number !== undefined && number !== null) description = Array.isArray(number) ? number.join(".") : String(number);
    }
    return description ? format("[%s](#%s)", description, getReference(destination, info)) : undefined;
  }
  if (inlineImageP(l, varValue("org-html-inline-image-rules"))) {
    const p = type !== "file" ? type + ":" + rawPath : !e8.fileNameAbsoluteP(rawPath) ? rawPath : e8.expandFileName(rawPath);
    const parent = parentElement(l);
    const caption = data(parent ? getCaption(parent) ?? [] : [], info);
    return format("![img](%s)", !nw(caption) ? p : format('%s "%s"', p, caption));
  }
  if (type === "coderef") return format(getCoderefFormat(path, desc), resolveCoderef(path, info));
  if (type === "radio") {
    const destination = resolveRadioLink(l, info);
    return !destination ? desc : format('<a href="#%s">%s</a>', getReference(destination, info), desc);
  }
  return !desc ? `<${path}>` : `[${desc}](${path})`;
}

function paragraph(p: Node, contents: string): string {
  const c = contents.replace(/\n(?:[ \t\f\v]*\n)+/g, "\n");
  const first = p.contents[0];
  return typeof first === "string" && first.startsWith("#") ? "\\" + c : c;
}

function plainText(text: string, info: Info): string {
  if (nonNil(info["with-smart-quotes"])) text = activateSmartQuotes(text, "html", info);
  text = text.replace(/[`*_\\]/g, "\\$&");
  text = text.replace(/\n#/g, "\n\\#");
  text = text.replace(/!\[/g, "\\![");
  if (nonNil(info["with-special-strings"])) text = convertSpecialStrings(text);
  if (nonNil(info["preserve-breaks"])) text = text.replace(/[ \t]*\n/g, "  \n");
  return text;
}

function innerTemplate(contents: string, info: Info): string {
  const depth = info["with-toc"];
  return (nonNil(depth) ? buildToc(info, typeof depth === "number" && depth >= 0 ? depth : undefined) + "\n" : "") + contents + "\n" + (footnoteSection(info) ?? "");
}

defineDerivedBackend("md", "html", {
  filters: { "filter-parse-tree": separateElements },
  menu: [
    "m",
    "Export to Markdown",
    [
      ["M", "To temporary buffer", (a: boolean, s: boolean, v: boolean) => exportAsMarkdown(a, s, v)],
      ["m", "To file", (a: boolean, s: boolean, v: boolean) => exportToMarkdown(a, s, v)],
      ["o", "To file and open", (a: boolean, s: boolean, v: boolean) => browseUrl("file://" + e8.expandFileName(exportToMarkdown(a, s, v)))],
    ],
  ],
  translate: {
    bold: (_b: Node, c: string) => format("**%s**", c),
    "center-block": convertToHtml,
    code: verbatim,
    drawer: identity,
    "dynamic-block": identity,
    "example-block": exampleBlock,
    "export-block": (b: Node, c: string | undefined, info: Info) => (["MARKDOWN", "MD"].includes(b.p.type) ? removeIndentation(b.p.value) : withBackend("html", b, c, info)),
    "fixed-width": exampleBlock,
    headline,
    "horizontal-rule": () => "---",
    "inline-src-block": verbatim,
    inlinetask: convertToHtml,
    "inner-template": innerTemplate,
    italic: (_i: Node, c: string) => format("*%s*", c),
    item,
    keyword,
    "latex-environment": latexEnvironment,
    "latex-fragment": latexFragment,
    "line-break": () => "  \n",
    link,
    "node-property": (p: Node) => format("%s:%s", p.p.key, p.p.value ? " " + p.p.value : ""),
    paragraph,
    "plain-list": identity,
    "plain-text": plainText,
    "property-drawer": (_p: Node, c: string | undefined) => (nw(c) ? c.replace(/^/gm, "    ") : undefined),
    "quote-block": (_q: Node, c: string) => c.replace(/\n$/, "").replace(/^/gm, "> "),
    section: identity,
    "special-block": convertToHtml,
    "src-block": exampleBlock,
    table: convertToHtml,
    template: (c: string) => c,
    verbatim,
  } as any,
  options: [
    ["md-footnote-format", undefined, undefined, "org-md-footnote-format"],
    ["md-footnotes-section", undefined, undefined, "org-md-footnotes-section"],
    ["md-headline-style", undefined, undefined, "org-md-headline-style"],
    ["md-toplevel-hlevel", undefined, undefined, "org-md-toplevel-hlevel"],
  ],
});

export function exportAsMarkdown(_async?: unknown, subtreep?: unknown, visibleOnly?: unknown): string {
  return toBuffer("md", "*Org MD Export*", flag(subtreep), flag(visibleOnly), false, {}, () => {
    if (e8.fboundp("text-mode")) e8.call("text-mode" as any);
  });
}

export function exportToMarkdown(_async?: unknown, subtreep?: unknown, visibleOnly?: unknown): string {
  const file = outputFileName(".md", flag(subtreep));
  return toFile("md", file, flag(subtreep), flag(visibleOnly));
}

e8.defineCommand({
  name: "org-md-export-as-markdown",
  doc: "Export current buffer to a Markdown buffer, *Org MD Export*.\n\nWith SUBTREEP, export the subtree at point; with VISIBLE-ONLY, only visible text.",
  params: EXPORT_PARAMS,
  run: (a, s, v) => {
    exportAsMarkdown(a, s, v);
  },
});

e8.defineCommand({
  name: "org-md-export-to-markdown",
  doc: "Export current buffer to a Markdown file, named after the buffer's file with .md; return its name.",
  params: EXPORT_PARAMS,
  run: (a, s, v) => {
    exportToMarkdown(a, s, v);
  },
});

e8.defineCommand({
  name: "org-md-convert-region-to-md",
  doc: "Assume the current region has Org syntax, and convert it to Markdown.",
  run: () => replaceRegionBy("md"),
});

/** Publish an Org file to Markdown, as org-md-publish-to-md; returns the file written. */
e8.defun("org-md-publish-to-md", (plist: e8.Value[], filename: string, pubDir: string) => publishOrgTo("md", filename, ".md", plist, pubDir));

void extPlistOf;
