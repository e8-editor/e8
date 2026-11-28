// htmlize, after Hrvoje Nikšić's htmlize.el, a package Emacs does not ship
// and Org's HTML export uses to colour source blocks: a buffer, or part of
// one, as HTML that looks as it does in the editor, each run of text in
// the faces it has after fontifying. htmlize-output-type says how: css,
// spans with a class per face and a stylesheet in the head; inline-css,
// spans with the faces' attributes in a style attribute; font, <font>,
// <b> and the like.
//
// Written from htmlize's documented behaviour and output, not its code.
// The faces are E8's, so colours follow E8's themes and tree-sitter modes
// rather than Emacs's (docs/differences.md). A tree-sitter mode's faces
// come from its syntax tree, and are read from a copy of the buffer, so
// the buffer itself gets no face properties.

import { charCount } from "subr";

const S = (name: string) => e8.intern(name);
const defvar = (name: string, value: e8.Value, doc: string, local = false) => e8.defineVariable({ name, value, doc, local });

defvar("htmlize-version", "1.57", "The version of htmlize whose output this follows, written in the comment each HTML file starts with.");
defvar(
  "htmlize-output-type",
  S("css"),
  "How htmlize marks up faces: css, spans with a class per face, defined in a style sheet in the head; inline-css, spans with the faces' attributes in style attributes; font, <font> and <b>, <i>, <u> and <strike> tags.",
);
defvar("htmlize-css-name-prefix", "", 'The prefix of the CSS class names faces get, as "org-" for Org\'s export.');
defvar(
  "htmlize-face-overrides",
  null,
  'Faces to show in other attributes than their own, as a plist of a face and an attribute list or a foreground colour: ["font-lock-keyword-face", [":foreground", "red", ":weight", "bold"], "font-lock-comment-face", "gray50"].',
);
defvar("htmlize-html-charset", null, "The charset an HTML file says it is in, with a <meta> tag in its head; nil writes none.");
defvar("htmlize-convert-nonascii-to-entities", true, "Whether characters beyond ASCII are written as numeric entities, &#233;; nil copies them as they are.");
defvar("htmlize-untabify", true, "Whether tabs are written as the spaces they show as.");
defvar("htmlize-head-tags", "", "More tags for the head of each HTML file, after its title.");
defvar(
  "htmlize-hyperlink-style",
  "\n      a {\n        color: inherit;\n        background-color: inherit;\n        font: inherit;\n        text-decoration: inherit;\n      }\n      a:hover {\n        text-decoration: underline;\n      }\n",
  "The style of links, at the end of the style sheet css output writes.",
);
defvar(
  "htmlize-ignore-face-size",
  S("absolute"),
  "Which faces' sizes to leave out: absolute, those given in points, keeping the relative ones; t, all; nil, none.",
);
defvar("htmlize-pre-style", null, "Whether the <pre> holding the text gets the default face's style, as the body does.");
defvar("htmlize-ellipsis", "...", "What stands for invisible text that shows as an ellipsis.");
defvar("htmlize-html-major-mode", null, "The major mode the HTML buffer is put in; nil leaves it in Fundamental mode.");
defvar(
  "htmlize-background-mode",
  S("light"),
  "The background whose colours faces are written in: light, as a page and Org's style sheet are, or dark; nil takes the frame's, as frame-background-mode says. E8's own: htmlize takes the frame's, which in emacs -Q is light, where E8's is dark without a front end to say.",
);
defvar(
  "htmlize-buffer-places",
  null,
  "Where the parts of an HTML buffer htmlize made start and end, as a plist: head-start, head-end, body-start, content-start, content-end and body-end.",
  true,
);
e8.defineHook("htmlize-before-hook", "Run in the buffer to be made HTML, before htmlize reads it.");
e8.defineHook("htmlize-after-hook", "Run in the HTML buffer htmlize made, once it is finished.");
e8.defineHook("htmlize-file-hook", "Run in the HTML buffer of htmlize-file, before it is written.");

// --- Faces as attributes --------------------------------------------------------

/** A face's attributes as htmlize writes them, and its class name: htmlize's fstruct. */
interface FStruct {
  foreground?: string;
  background?: string;
  /** A factor, float, or an absolute size in tenths of a point. */
  size?: Size;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  overline?: boolean;
  strike?: boolean;
  cssName: string;
}

type Size = { factor: number } | { absolute: number };

/** A face as text gives it: a face's name, or an attribute list. */
type Face = string | e8.Value[];

const nonNil = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== "unspecified" && !(Array.isArray(v) && v.length === 0);
const nameOf = (v: unknown): string => (typeof v === "symbol" ? e8.symbolName(v) : String(v));

/** The output type, from the variable: css, inline-css, font, or undefined for nil. */
export function outputType(value: e8.Value | undefined = e8.variable("htmlize-output-type")): "css" | "inline-css" | "font" | undefined {
  if (!nonNil(value) || value === true) return value === true ? "css" : undefined;
  const name = nameOf(value);
  return name === "nil" ? undefined : name === "inline-css" || name === "font" ? name : "css";
}

const hex = (bytes: number[]) => "#" + bytes.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/**
 * A colour as #rrggbb, as htmlize-color-to-rgb: kept if it already is,
 * else from its values, else as it is. One of E8's palette names is the
 * colour it draws on the frame's background, and a translucent one, as
 * the palette's faint and muted are, laid over the default face's
 * background, as it shows.
 */
function colorToRgb(color: unknown): string | undefined {
  if (typeof color !== "string" || color === "unspecified" || color === "") return undefined;
  if (color.startsWith("#") && color.length !== 9) return color;
  const values = e8.colorValues(color);
  if (values) return hex(values.map((v) => Math.floor(v / 256)));
  const rgba = e8.colorRgba(color);
  if (!rgba) return color;
  const [r, g, b, a] = rgba;
  if (a >= 255) return hex([r, g, b]);
  const under = e8.colorRgba(faceColor("default", false) ?? "bg") ?? [255, 255, 255, 255];
  return hex([r, g, b].map((c, i) => (c * a + under[i] * (255 - a)) / 255));
}

/** A face's height as htmlize takes it: a factor, or absolute in tenths of a point. */
function sizeOf(height: unknown): Size | undefined {
  if (typeof height === "number") return Number.isInteger(height) ? { absolute: height } : { factor: height };
  if (height && typeof height === "object" && typeof (height as { factor?: unknown }).factor === "number") return { factor: (height as { factor: number }).factor };
  return undefined;
}

/** The size of text in two sizes, the later one inheriting from the earlier, as htmlize-merge-size. */
function mergeSize(merged: Size | undefined, next: Size | undefined): Size | undefined {
  if (merged === undefined) return next;
  if (next === undefined) return merged;
  if ("absolute" in next) return next;
  if ("factor" in merged) return { factor: merged.factor * next.factor };
  return { absolute: Math.round(merged.absolute * next.factor) };
}

/** Set an attribute of an fstruct from a face attribute and its value, as htmlize-face-set-from-keyword-attr. */
function setFromKeywordAttr(fs: FStruct, attr: string, value: e8.Value): void {
  switch (attr) {
    case ":foreground":
      fs.foreground = colorToRgb(nameOf(value));
      break;
    case ":background":
      fs.background = colorToRgb(nameOf(value));
      break;
    case ":height":
      fs.size = sizeOf(value);
      break;
    case ":weight":
      // As htmlize matches the weight's name in "bold": bold, not semi-bold or extra-bold.
      if ("bold".includes(nameOf(value))) fs.bold = true;
      break;
    case ":slant":
      fs.italic = nameOf(value) === "italic" || nameOf(value) === "oblique";
      break;
    case ":bold":
      fs.bold = nonNil(value);
      break;
    case ":italic":
      fs.italic = nonNil(value);
      break;
    case ":underline":
      fs.underline = nonNil(value);
      break;
    case ":overline":
      fs.overline = nonNil(value);
      break;
    case ":strike-through":
      fs.strike = nonNil(value);
      break;
  }
}

/** An attribute list as an fstruct, as htmlize-attrlist-to-fstruct. */
function attrlistToFstruct(attrlist: e8.Value[], name?: string): FStruct {
  const fs: FStruct = { cssName: name ?? "custom" };
  if (attrlist[0] === "foreground-color" || attrlist[0] === "background-color") {
    const color = colorToRgb(nameOf(attrlist[1]));
    if (attrlist[0] === "foreground-color") fs.foreground = color;
    else fs.background = color;
    return fs;
  }
  for (let i = 0; i + 1 < attrlist.length; i += 2) {
    const value = attrlist[i + 1];
    if (nonNil(value)) setFromKeywordAttr(fs, nameOf(attrlist[i]), value);
  }
  return fs;
}

/**
 * A face's colour, as htmlize-face-color-internal; the default face's, if
 * it sets none, the palette's ink and bg, which E8 draws it in, where
 * htmlize takes black on white.
 */
function faceColor(face: string, foreground: boolean): string | undefined {
  const color = e8.faceAttribute(face, foreground ? ":foreground" : ":background", true);
  if (typeof color === "string" && color !== "unspecified" && color !== "unspecified-fg" && color !== "unspecified-bg") return color;
  return face === "default" ? (foreground ? "ink" : "bg") : undefined;
}

/** A face's size, its own times what it inherits, as htmlize-face-size. */
function faceSize(face: string): Size | undefined {
  const faces: string[] = [face];
  for (let i = 0; i < faces.length && i < 64; i++) {
    const inherit = e8.faceAttribute(faces[i], ":inherit", false);
    if (Array.isArray(inherit)) faces.push(...inherit.map(nameOf));
    else if (nonNil(inherit)) faces.push(nameOf(inherit));
  }
  let size: Size | undefined;
  for (const f of faces) if (e8.facep(f)) size = mergeSize(size, sizeOf(e8.faceAttribute(f, ":height", false)));
  return size;
}

/** A named face as an fstruct, its attributes with what it inherits, as htmlize-face-to-fstruct-1. */
function faceToFstruct1(face: string): FStruct {
  const fs: FStruct = { cssName: "", foreground: colorToRgb(faceColor(face, true)), background: colorToRgb(faceColor(face, false)) };
  for (const attr of [":weight", ":slant", ":underline", ":overline", ":strike-through"]) {
    const value = e8.faceAttribute(face, attr, true);
    if (nonNil(value)) setFromKeywordAttr(fs, attr, value);
  }
  const size = faceSize(face);
  if (size && !("factor" in size && size.factor === 1)) fs.size = size;
  return fs;
}

/** What htmlize-face-overrides says of a face: an fstruct in its place, or undefined. */
function overrideFstruct(face: string): FStruct | undefined {
  const overrides = e8.variable("htmlize-face-overrides");
  if (!Array.isArray(overrides)) return undefined;
  let raw: e8.Value | undefined;
  for (let i = 0; i + 1 < overrides.length; i += 2) if (nameOf(overrides[i]) === face) raw = overrides[i + 1];
  // An alist's entries, [face, attributes], as well as the plist htmlize documents.
  if (raw === undefined) for (const entry of overrides) if (Array.isArray(entry) && nameOf(entry[0]) === face) raw = entry.length === 2 ? entry[1] : entry.slice(1);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return attrlistToFstruct([":foreground", raw], face);
  if (Array.isArray(raw)) return raw.length ? attrlistToFstruct(raw, face) : undefined;
  return e8.signal("error", `face override must be an attribute list or string, got ${String(raw)}`);
}

/** Fstructs into one, the later ones' attributes winning, as htmlize-merge-faces. */
function mergeFaces(list: FStruct[]): FStruct {
  if (list.length === 0) return { cssName: "" };
  if (list.length === 1) return list[0];
  const merged: FStruct = { cssName: "" };
  for (const f of list) {
    for (const k of ["foreground", "background", "bold", "italic", "underline", "overline", "strike"] as const) if (f[k]) (merged as any)[k] = f[k];
    merged.size = mergeSize(merged.size, f.size);
  }
  return merged;
}

/** A face's CSS class name, as htmlize-face-css-name: font-lock- and -face dropped, what CSS does not allow made X, with the prefix. */
export function cssName(face: string, prefix: string = String(e8.variable("htmlize-css-name-prefix") ?? "")): string {
  let name = e8.downcase(face).replace(/^font-lock-/, "").replace(/-face$/, "").replace(/[^-a-zA-Z0-9]/g, "X");
  if (/^[-0-9]/.test(name)) name = "X" + name;
  if (name === "") name = "face";
  return prefix + name;
}

/** The face remapping of a face in the current buffer, as face-remapping-alist gives it. */
function remapping(face: string): Face[] | undefined {
  const alist = e8.variable("face-remapping-alist");
  if (!Array.isArray(alist)) return undefined;
  for (const entry of alist) if (Array.isArray(entry) && nameOf(entry[0]) === face) return entry.slice(1).map((f) => (Array.isArray(f) ? f : nameOf(f)));
  return undefined;
}

/** A face as an fstruct, as htmlize-face-to-fstruct: overrides and remapping applied. */
function faceToFstruct(face: Face): FStruct {
  const faces: Face[] = (typeof face === "string" && remapping(face)) || [face];
  const fs = mergeFaces(faces.reverse().map((f) => (typeof f === "string" ? (overrideFstruct(f) ?? faceToFstruct1(f)) : attrlistToFstruct(f))));
  if (typeof face === "string") return { ...fs, cssName: cssName(face) };
  return fs;
}

/** The attributes whose values are symbols in Lisp, so printed without quotes. */
const SYMBOL_VALUED = new Set([":weight", ":slant", ":width", ":inherit"]);

/** A value as Lisp prints it: a factor height as a float, 3.0, strings quoted, symbols and keywords bare. */
function prin1Value(v: unknown, bare = false): string {
  if (v === true) return "t";
  if (v === false || v === null || v === undefined) return "nil";
  if (typeof v === "symbol") return e8.symbolName(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return bare || v.startsWith(":") ? v : `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  if (Array.isArray(v)) return "(" + v.map((x, i) => prin1Value(x, i > 0 && typeof v[i - 1] === "string" && SYMBOL_VALUED.has(v[i - 1] as string))).join(" ") + ")";
  if (typeof v === "object" && typeof (v as { factor?: unknown }).factor === "number") {
    const factor = (v as { factor: number }).factor;
    return Number.isInteger(factor) ? `${factor}.0` : String(factor);
  }
  return String(v);
}

/** A face written as Lisp prints it, for a style sheet's comments and as a key. */
function prin1(face: Face): string {
  return typeof face === "string" ? face : prin1Value(face);
}

/** The faces a face property names, as htmlize-decode-face-prop: names of faces that exist, attribute lists, or lists of these. */
function decodeFaceProp(prop: e8.Value | undefined): Face[] {
  if (prop === undefined || prop === null || prop === false) return [];
  if (typeof prop === "string" || typeof prop === "symbol") {
    const name = nameOf(prop);
    return e8.facep(name) ? [name] : [];
  }
  if (!Array.isArray(prop) || prop.length === 0) return [];
  const head = prop[0];
  if ((typeof head === "string" || typeof head === "symbol") && nameOf(head).startsWith(":")) return [prop];
  if (head === "foreground-color" || head === "background-color") return [prop];
  return prop.flatMap((p) => decodeFaceProp(p));
}

/** The CSS of an fstruct, as htmlize-css-specs. */
function cssSpecs(fs: FStruct): string[] {
  const out: string[] = [];
  if (fs.foreground) out.push(`color: ${fs.foreground};`);
  if (fs.background) out.push(`background-color: ${fs.background};`);
  const ignore = e8.variable("htmlize-ignore-face-size");
  const ignoreName = ignore === true ? "t" : nonNil(ignore) ? nameOf(ignore) : "nil";
  if (fs.size && ignoreName !== "t") {
    if ("factor" in fs.size) out.push(`font-size: ${Math.trunc(fs.size.factor * 100)}%;`);
    else if (ignoreName !== "absolute") {
      const pt = fs.size.absolute / 10;
      out.push(`font-size: ${Number.isInteger(pt) ? `${pt}.0` : pt}pt;`);
    }
  }
  if (fs.bold) out.push("font-weight: bold;");
  if (fs.italic) out.push("font-style: italic;");
  if (fs.underline) out.push("text-decoration: underline;");
  if (fs.overline) out.push("text-decoration: overline;");
  if (fs.strike) out.push("text-decoration: line-through;");
  return out;
}

/** The faces of the buffer's text and their fstructs, each class name unique, as htmlize-make-face-map. */
class FaceMap {
  readonly fstructs = new Map<string, FStruct>();
  readonly faces = new Map<string, Face>();
  private readonly names = new Set<string>();

  constructor() {
    this.get("default");
  }

  /** A face's fstruct, made the first time. */
  get(face: Face): FStruct {
    const key = prin1(face);
    let fs = this.fstructs.get(key);
    if (fs) return fs;
    fs = faceToFstruct(face);
    let name = fs.cssName;
    for (let i = 1; this.names.has(name); i++) name = `${fs.cssName}-${i}`;
    fs = { ...fs, cssName: name };
    this.names.add(name);
    this.fstructs.set(key, fs);
    this.faces.set(key, face);
    return fs;
  }
}

// --- Text ----------------------------------------------------------------------

/** Text as HTML, as htmlize-protect-string: &, < and > escaped, control characters and, unless told not to, those beyond ASCII as entities. */
export function protectString(text: string): string {
  if (!/[^\r\n\t -%'-;=?-~]/.test(text)) return text;
  const entities = nonNil(e8.variable("htmlize-convert-nonascii-to-entities"));
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === "\n" || ch === "\r" || ch === "\t") out += ch;
    else if (code < 32 || code === 127) out += `&#${code};`;
    else if (code < 128 || !entities) out += ch;
    else out += `&#${code};`;
  }
  return out;
}

/** Text with its tabs as spaces, starting at a column, as htmlize-untabify-string. */
function untabify(text: string, column: number, tabWidth: number): string {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) {
    if (ch === "\t") {
      const n = tabWidth - (column % tabWidth);
      out += " ".repeat(n);
      column += n;
    } else if (ch === "\n") {
      out += ch;
      column = 0;
    } else {
      out += ch;
      column++;
    }
  }
  return out;
}

/** Keeps Emacs from reading the HTML's text as a file's local variables, as htmlize-defang-local-variables. */
function defangLocalVariables(html: string): string {
  return html.replace(/Local Variables:/g, "Local Variables&#58;");
}

/**
 * The faces tree-sitter gives the text from start to end, one face or
 * none per character, as the syntax tree's faces are not text
 * properties. They are read from a copy of the whole buffer, widened, in
 * a buffer of the same mode, so that text in a region keeps its context,
 * as font-lock's widening keeps it: a region inside a comment is comment.
 */
function syntaxFaces(start: number, end: number): (string | undefined)[] {
  const text = e8.saveRestriction(() => {
    e8.call("widen");
    return e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
  });
  const mode = String(e8.variable("major-mode"));
  const name = e8.generateNewBufferName(" *htmlize syntax*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => {
      e8.bufferDisableUndo();
      e8.call(mode as e8.CommandName);
      e8.insert(text);
      const faces: (string | undefined)[] = new Array(end - start).fill(undefined);
      if (e8.treesitLanguage() === undefined) return faces;
      e8.treesitFontLockFontifyRegion(start, end);
      for (let p = start; p < end; ) {
        const next = Math.min(e8.nextSinglePropertyChange(p, "face", end) ?? end, end);
        const face = e8.getTextProperty(p, "face");
        if (typeof face === "string") for (let i = p; i < next; i++) faces[i - start] = face;
        p = next;
      }
      return faces;
    });
  } finally {
    e8.call("kill-buffer", name);
  }
}

/**
 * The faces at a position, as htmlize-faces-at-point: the text's, the
 * most specific last, then the overlays'. Text with no face takes its
 * font-lock-face, as char-property-alias-alist makes it in Emacs and E8
 * draws it.
 */
function facesAt(pos: number, syntax: string | undefined): Face[] {
  const own = e8.getTextProperty(pos, "face");
  const faces = decodeFaceProp(own === undefined ? e8.getTextProperty(pos, "font-lock-face") : own).reverse();
  // The syntax tree's face lies under the text's own, as redisplay draws them.
  if (syntax !== undefined && e8.facep(syntax)) faces.unshift(syntax);
  const overlays = e8
    .overlaysAt(pos)
    .filter((o) => nonNil(e8.overlayGet(o, "face")))
    .map((o, i) => [o, Number(e8.overlayGet(o, "priority") ?? 0) || 0, i] as const)
    .sort((a, b) => b[1] - a[1] || a[2] - b[2]);
  let list: Face[] = [];
  for (const [o] of overlays.reverse()) list = [...decodeFaceProp(e8.overlayGet(o, "face")), ...list];
  return faces.concat(list);
}

/** How a list of fstructs opens and closes its markup in each output type. */
function textMarkup(type: "css" | "inline-css" | "font", fstructs: FStruct[]): [string, string] {
  if (type === "css") return [fstructs.map((f) => `<span class="${f.cssName}">`).join(""), "</span>".repeat(fstructs.length)];
  const merged = mergeFaces(fstructs);
  if (type === "inline-css") {
    const specs = cssSpecs(merged);
    return specs.length ? [`<span style="${specs.join(" ")}">`, "</span>"] : ["", ""];
  }
  return [
    (merged.foreground ? `<font color="${merged.foreground}">` : "") + (merged.bold ? "<b>" : "") + (merged.italic ? "<i>" : "") + (merged.underline ? "<u>" : "") + (merged.strike ? "<strike>" : ""),
    (merged.strike ? "</strike>" : "") + (merged.underline ? "</u>" : "") + (merged.italic ? "</i>" : "") + (merged.bold ? "</b>" : "") + (merged.foreground ? "</font>" : ""),
  ];
}

/** The style sheet of css output, as htmlize-css-insert-head: the body's, then each face's, by class name. */
function cssHead(map: FaceMap, bufferFaces: string[]): string {
  let out = '    <style type="text/css">\n    <!--\n';
  out += "      body {\n        " + cssSpecs(map.fstructs.get("default")!).join("\n        ") + "\n      }\n";
  const sorted = bufferFaces.map((k) => map.fstructs.get(k)!).map((fs, i) => [fs, bufferFaces[i]] as const);
  sorted.sort((a, b) => (a[0].cssName < b[0].cssName ? -1 : a[0].cssName > b[0].cssName ? 1 : 0));
  for (const [fs, key] of sorted) {
    const comment = key.replace(/--+/g, "-").replace(/\*\//g, "XX");
    const specs = cssSpecs(fs);
    out += `      .${fs.cssName}` + (specs.length ? ` {\n        /* ${comment} */\n        ${specs.join("\n        ")}` : " {") + "\n      }\n";
  }
  return out + String(e8.variable("htmlize-hyperlink-style") ?? "") + "    -->\n    </style>\n";
}

/** The parts of the HTML htmlize makes and where each starts and ends. */
export interface Htmlized {
  html: string;
  /** head-start, head-end, body-start, content-start, content-end and body-end, as character offsets in html. */
  places: { [place: string]: number };
}

/**
 * The accessible part of the current buffer as an HTML document, as
 * htmlize-buffer-1 writes it, without making its buffer. With `fontified`,
 * the text's face properties are taken as they are: nothing is fontified,
 * nor tree-sitter's faces read, as Org's export has already put them.
 * Faces' colours are those for htmlize-background-mode's background.
 */
export function htmlizeAccessible(options: { fontified?: boolean } = {}): Htmlized {
  const mode = e8.variable("htmlize-background-mode");
  if (!nonNil(mode)) return htmlizeAccessible1(options);
  return e8.letBind({ "frame-background-mode": nameOf(mode) }, () => htmlizeAccessible1(options));
}

function htmlizeAccessible1(options: { fontified?: boolean }): Htmlized {
  e8.saveExcursion(() => e8.runHooks("htmlize-before-hook"));
  const type = outputType() ?? "css";
  const start = e8.pointMin();
  const end = e8.pointMax();
  let syntax: (string | undefined)[] | undefined;
  if (!options.fontified) {
    e8.call("font-lock-ensure");
    if (e8.treesitLanguage() !== undefined) syntax = syntaxFaces(start, end);
  }
  const map = new FaceMap();
  const bufferFaces: string[] = [];
  const seen = new Set<string>(["default"]);
  const untabifying = nonNil(e8.variable("htmlize-untabify"));
  const tabWidth = Number(e8.variable("tab-width")) || 8;
  const ellipsis = String(e8.variable("htmlize-ellipsis") ?? "");
  let body = "";
  let close = "";
  let last: string | undefined;
  let trailingEllipsis = false;
  for (let pos = start; pos < end; ) {
    let next = e8.nextCharPropertyChange(pos, end);
    if (syntax) {
      const s = syntax[pos - start];
      for (let i = pos + 1; i < next; i++)
        if (syntax[i - start] !== s) {
          next = i;
          break;
        }
    }
    const faces = facesAt(pos, syntax?.[pos - start]);
    const keys = faces.map(prin1);
    for (let i = 0; i < faces.length; i++)
      if (!seen.has(keys[i])) {
        seen.add(keys[i]);
        map.get(faces[i]);
        bufferFaces.push(keys[i]);
      }
    const fstructs = faces.map((f) => map.get(f));
    let text: string;
    const invisible = e8.invisibleP(pos);
    if (invisible) {
      text = invisible === "ellipsis" && !trailingEllipsis ? ellipsis : "";
      if (invisible === "ellipsis") trailingEllipsis = true;
    } else {
      text = e8.bufferSubstringNoProperties(pos, next);
      if (text.length) trailingEllipsis = false;
      if (untabifying && text.includes("\t")) {
        const column = e8.saveExcursion(() => {
          e8.gotoChar(pos);
          return e8.currentColumn();
        });
        text = untabify(text, column, tabWidth);
      }
    }
    if (text.length > 0) {
      const key = fstructs.map((f) => f.cssName).join("\0") + "\0" + keys.join("\0");
      if (key !== last) {
        body += close;
        const [open, shut] = textMarkup(type, fstructs);
        body += open;
        close = shut;
        last = key;
      }
      body += protectString(text);
    }
    pos = next;
  }
  body += close;
  return assemble(type, map, bufferFaces, defangLocalVariables(body));
}

/** The document around the text, as htmlize-buffer-1 writes it, and where its parts are. */
function assemble(type: "css" | "inline-css" | "font", map: FaceMap, bufferFaces: string[], body: string): Htmlized {
  const file = e8.bufferFileName();
  const title = file !== undefined ? e8.fileNameNondirectory(file) : e8.bufferName();
  const charset = e8.variable("htmlize-html-charset");
  const dflt = map.fstructs.get("default")!;
  const preStyle = nonNil(e8.variable("htmlize-pre-style"));
  const places: { [place: string]: number } = {};
  let html = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">\n' + `<!-- Created by htmlize-${String(e8.variable("htmlize-version"))} in ${type} mode. -->\n` + "<html>\n  ";
  const mark = (place: string) => (places[place] = charCount(html));
  mark("head-start");
  html +=
    "<head>\n    <title>" +
    defangLocalVariables(protectString(title)) +
    "</title>\n" +
    (nonNil(charset) ? `    <meta http-equiv="Content-Type" content="text/html; charset=${nameOf(charset)}">\n` : "") +
    String(e8.variable("htmlize-head-tags") ?? "");
  if (type === "css") html += cssHead(map, bufferFaces);
  html += "  </head>";
  mark("head-end");
  html += "\n  ";
  mark("body-start");
  html +=
    (type === "inline-css" ? `<body style="${cssSpecs(dflt).join(" ")}">` : type === "font" ? `<body text="${dflt.foreground}" bgcolor="${dflt.background}">` : "<body>") + "\n    ";
  mark("content-start");
  html += (preStyle && type === "css" ? `<pre class="${dflt.cssName}">` : preStyle && type === "inline-css" ? `<pre style="${cssSpecs(dflt).join(" ")}">` : "<pre>") + "\n";
  html += body + "</pre>";
  mark("content-end");
  html += "\n  </body>";
  mark("body-end");
  html += "\n</html>\n";
  return { html, places };
}

/** Make a buffer of the HTML, named after the file, as htmlize-buffer-1 does, and return its name. */
function htmlBuffer(htmlized: Htmlized): string {
  const file = e8.bufferFileName();
  const name = e8.generateNewBufferName(file !== undefined ? e8.fileNameNondirectory(file) + ".html" : "*html*");
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.insert(htmlized.html);
    e8.gotoChar(e8.pointMin());
    const mode = e8.variable("htmlize-html-major-mode");
    if (nonNil(mode) && e8.fboundp(nameOf(mode))) e8.call(nameOf(mode) as e8.CommandName);
    e8.makeLocalVariable("htmlize-buffer-places");
    e8.setVariable("htmlize-buffer-places", Object.entries(htmlized.places).flatMap(([k, v]) => [S(k), v]));
    e8.runHooks("htmlize-after-hook");
  });
  return name;
}

// --- Commands and functions -------------------------------------------------------

/** The accessible part of the current buffer, or another's, as HTML in a buffer of its own, as htmlize-buffer; returns its name. */
export function htmlizeBuffer(buffer?: e8.BufferLike): string {
  return e8.withCurrentBuffer(buffer ?? e8.bufferName(), () => htmlBuffer(htmlizeAccessible()));
}

/** The text between two of htmlize-buffer-places in an HTML buffer htmlize made, as content-start and content-end. */
export function placesText(html: string, from: string, to: string): string {
  return e8.withCurrentBuffer(html, () => {
    const places = e8.variable("htmlize-buffer-places");
    const at = (place: string) => {
      const list = Array.isArray(places) ? places : [];
      return Number(list[list.findIndex((p) => typeof p === "symbol" && e8.symbolName(p) === place) + 1]);
    };
    return e8.bufferSubstringNoProperties(at(from), at(to));
  });
}

/** The text from start to end as HTML in a buffer of its own, as htmlize-region; returns its name. */
export function htmlizeRegion(start: number, end: number, options: { fontified?: boolean } = {}): string {
  return e8.saveRestriction(() => {
    e8.narrowToRegion(Math.min(start, end), Math.max(start, end));
    return htmlBuffer(htmlizeAccessible(options));
  });
}

/** The text from start to end as HTML: its <pre> and what it holds, with inline CSS, as htmlize-region-for-paste. */
export function htmlizeRegionForPaste(start: number, end: number): string {
  return e8.letBind({ "htmlize-output-type": S("inline-css") }, () => {
    // Through a buffer of its own, as htmlize's goes through htmlize-region, so its mode and htmlize-after-hook run.
    const html = htmlizeRegion(start, end);
    try {
      return placesText(html, "content-start", "content-end");
    } finally {
      e8.call("kill-buffer", html);
    }
  });
}

/** The HTML file htmlize makes from a file, as htmlize-make-file-name: its name with .html. */
export function makeFileName(file: string): string {
  return `${file}.html`;
}

/** A file as HTML, written beside it, in TARGET if a directory, or as TARGET; as htmlize-file. */
export function htmlizeFile(file: string, target?: string): void {
  const output = target && !e8.fileDirectoryP(target) ? target : e8.expandFileName(makeFileName(e8.fileNameNondirectory(file)), target || e8.fileNameDirectory(e8.expandFileName(file)));
  // Visiting the file renames the buffer after it, so it is known by its object.
  const buffer = e8.getBufferCreate(e8.generateNewBufferName(" *htmlize-file*"));
  try {
    e8.withCurrentBuffer(buffer, () => {
      e8.insertFileContents(file);
      e8.setVisitedFileName(e8.expandFileName(file));
      try {
        e8.call("normal-mode");
        const html = htmlBuffer(htmlizeAccessible());
        try {
          e8.withCurrentBuffer(html, () => {
            e8.runHooks("htmlize-file-hook");
            e8.writeRegion(null, null, output, { quiet: true });
          });
        } finally {
          e8.call("kill-buffer", html);
        }
      } finally {
        e8.setVisitedFileName(null);
        e8.setBufferModified(false);
      }
    });
  } finally {
    const name = e8.bufferName(buffer);
    if (name !== undefined) e8.call("kill-buffer", name);
  }
}

/** Each of FILES as HTML, in TARGET-DIRECTORY or beside it, as htmlize-many-files. */
export function htmlizeManyFiles(files: string[], targetDirectory?: string): void {
  if (targetDirectory && !e8.fileDirectoryP(targetDirectory)) e8.signal("error", `target-directory must name a directory: ${targetDirectory}`);
  for (const file of files) htmlizeFile(file, targetDirectory);
}

const given = (v: unknown): v is string => typeof v === "string" && v !== "";

// The optional arguments are of kind prefix, which code may leave out; run from a key, they get the prefix argument, which is no buffer, file or list of files.

e8.defineCommand({
  name: "htmlize-buffer",
  doc: "Convert the buffer to HTML, preserving colors and decorations.\n\nThe HTML is in a buffer of its own, named after the buffer's file with .html, or *html*, shown when run from a key or M-x. htmlize-output-type says how faces are marked up.",
  params: [{ name: "buffer", kind: "prefix" }],
  run: (buffer?: e8.Value) => {
    const html = htmlizeBuffer((given(buffer) || typeof buffer === "object") && e8.bufferLiveP(buffer) ? (buffer as e8.BufferLike) : undefined);
    if (e8.calledInteractively()) e8.call("switch-to-buffer", html);
  },
});

e8.defineCommand({
  name: "htmlize-region",
  doc: "Convert the region to HTML, preserving colors and decorations.\n\nAs htmlize-buffer, for the text between start and end.",
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
  ],
  run: (beg: number, end: number) => {
    e8.deactivateMark();
    const html = htmlizeRegion(beg, end);
    if (e8.calledInteractively()) e8.call("switch-to-buffer", html);
  },
});

e8.defineCommand({
  name: "htmlize-file",
  doc: "Load FILE, fontify it, convert it to HTML, and save the result.\n\nThe HTML goes beside FILE, with .html added to its name; TARGET, from code, is the directory to write it in or the file to write.",
  params: [
    { name: "file", kind: "file", prompt: "HTML-ize file: ", initial: () => "" },
    { name: "target", kind: "prefix" },
  ],
  run: (file: string, target?: string) => {
    htmlizeFile(file, given(target) ? target : undefined);
  },
});

e8.defineCommand({
  name: "htmlize-many-files",
  doc: "Convert FILES to HTML and save the corresponding HTML versions.\n\nRun from a key or M-x, it asks for files until the answer is empty. Each HTML file goes beside its file, or in TARGET-DIRECTORY.",
  params: [
    { name: "files", kind: "prefix" },
    { name: "target-directory", kind: "prefix" },
  ],
  run: async (files?: e8.Value, targetDirectory?: e8.Value) => {
    let list: string[];
    if (Array.isArray(files) && files.every((f) => typeof f === "string")) list = files as string[];
    else {
      list = [];
      for (;;) {
        const dir = list.length ? e8.fileNameDirectory(list[list.length - 1]) : undefined;
        const file = await e8.readFileName("HTML-ize file (RET to finish): ", { dir, default: "", mustMatch: true });
        if (file === "" || (dir !== undefined && file === dir)) break;
        list.push(file);
      }
    }
    htmlizeManyFiles(list, given(targetDirectory) ? targetDirectory : undefined);
  },
});

e8.defun("htmlize-region-for-paste", (beg: number, end: number) => htmlizeRegionForPaste(beg, end));
e8.defun("htmlize-make-file-name", (file: string) => makeFileName(file));
e8.defun("htmlize-protect-string", (s: string) => protectString(s));

