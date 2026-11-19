// Describing the character after a position, after Emacs's descr-text.el:
// describe-char (C-u C-x =) shows its code, charset, script, syntax,
// categories, how to type it, how the buffer and its file hold it, how it
// is shown, its Unicode properties and the text properties there; and
// describe-text-properties shows the overlays and text properties alone.

import { button, internalDescribeSyntaxValue, withHelpWindow } from "help";
import { charToName, ucsNames } from "mule";
import { truthy } from "subr";

e8.defineVariable({
  name: "describe-char-unidata-list",
  doc:
    "The Unicode properties describe-char shows, from char-code-property-alist: name, old-name, general-category, " +
    "decomposition and the rest; t for all of them.",
  value: ["name", "old-name", "general-category", "decomposition"],
});

/** A value as `%s` formats it in Lisp. */
const princ = (v: e8.Value): string => e8.prin1ToString(v, true);

/** Rounds as Emacs's two-argument round does, a half to the even neighbour. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** ISO 2022's control bytes by name, as iso-2022-control-alist. */
const ISO_2022_CONTROLS: Record<number, string> = { 0x1b: "ESC", 0x0e: "SO", 0x0f: "SI", 0x8e: "SS2", 0x8f: "SS3", 0x9b: "CSI" };

/** Encoded bytes as describe-char shows them, as encoded-string-description: #x41 each, ISO 2022's controls by name. */
export function encodedStringDescription(bytes: string, coding?: string | null): string {
  const iso = typeof coding === "string" && e8.codingSystemType(coding) === "iso-2022";
  return [...bytes]
    .map((b) => {
      const n = b.codePointAt(0)!;
      return (iso ? ISO_2022_CONTROLS[n] : undefined) ?? `#x${n.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join(" ");
}

/** A character encoded in a coding system, as encode-coding-char; undefined if it cannot write it. */
function encodeCodingChar(char: string, coding: string): string | undefined {
  if (e8.unencodableCharPosition(0, 1, coding, null, char) !== undefined) return undefined;
  return e8.encodeCodingString(char, coding);
}

/** How Emacs holds a character in a buffer, as encode-coding-string with emacs-internal: UTF-8, and a raw byte as #xC0 or #xC1 and its low six bits. */
function bufferCode(code: number): string {
  if (code >= 0x10ff80 && code <= 0x10ffff) {
    const byte = code - 0x10ff00;
    return encodedStringDescription(String.fromCharCode(0xc0 | ((byte >> 6) & 1), 0x80 | (byte & 0x3f)));
  }
  return encodedStringDescription(e8.encodeCodingString(String.fromCodePoint(code), "utf-8"));
}

/** What a property's value means, as char-code-property-description: a decomposition's characters each quoted. */
function propertyDescription(property: string, value: e8.Value): string | undefined {
  if (property === "decomposition" && Array.isArray(value)) {
    return value.map((x) => (typeof x === "number" ? `'${String.fromCodePoint(x)}'` : princ(x))).join(" ");
  }
  return e8.charCodePropertyDescription(property, value);
}

/** How a character is shown, as describe-char-display: its font and glyph on a graphic display, else its bytes for the terminal. */
function charDisplay(pos: number, char: string): string | undefined {
  if (e8.displayGraphicP()) {
    const info = e8.internalCharFont(pos, char);
    if (info === undefined) return undefined;
    const [font, code] = info;
    return `${princ(e8.fontGet(font, ":type") ?? null)}:${e8.fontXlfdName(font)} (#x${code.toString(16).toUpperCase().padStart(2, "0")})`;
  }
  const coding = e8.terminalCodingSystem() ?? "us-ascii";
  const encoded = encodeCodingChar(char, coding);
  return encoded === undefined ? undefined : encodedStringDescription(encoded, coding);
}

/** A row of describe-char: its label and its columns, plain or a button. */
type Row = [string, ...(string | e8.PropertizedString)[]];

/** The properties of a plist, each a line, sorted by name, as describe-property-list writes them. */
function propertyList(props: { [name: string]: e8.Value }): (string | e8.PropertizedString)[] {
  const out: (string | e8.PropertizedString)[] = [];
  for (const key of Object.keys(props).sort()) {
    const value = props[key];
    out.push("  ", e8.propertize(key, { face: "help-argument-name" }), " ".repeat(Math.max(0, 20 - key.length)), " ");
    if (key === "face" || key === "font-lock-face" || key === "mouse-face") {
      // A face's name stands for its symbol, printed without quotes.
      out.push(typeof value === "string" ? button(value, ["face", value]) : e8.prin1ToString(value));
    } else if (key === "category") out.push(princ(value));
    else out.push(e8.prin1ToString(value));
    out.push("\n");
  }
  return out;
}

/** What describe-text-properties shows of a position: the overlays there and the text properties, as describe-text-properties-1. */
function textPropertiesDescription(pos: number): (string | e8.PropertizedString)[] {
  const out: (string | e8.PropertizedString)[] = [];
  const overlays = e8.overlaysIn(pos, pos + 1);
  if (overlays.length > 0) {
    out.push("\n", overlays.length === 1 ? "There is an overlay here:\n" : `There are ${overlays.length} overlays here:\n`);
    for (const o of overlays) {
      out.push(` From ${(e8.overlayStart(o) ?? 0) + 1} to ${(e8.overlayEnd(o) ?? 0) + 1}\n`);
      out.push(...propertyList(e8.overlayProperties(o) ?? {}));
    }
    out.push("\n");
  }
  const props = e8.textPropertiesAt(pos);
  if (Object.keys(props).length > 0) {
    if (truthy(props.invisible ?? null)) {
      out.push(
        "\nNote that character has an invisibility property,\n" +
          "  so the character displayed at point in the buffer may\n" +
          "  differ from the character described here.\n",
      );
    }
    out.push("\nThere are text properties here:\n", ...propertyList(props));
  }
  return out;
}

/**
 * Shows in *Help* the character after `pos` and where it is, as
 * describe-char: its position and code, charset and code point there,
 * script, syntax, categories, how to type it, its bytes in the buffer, in
 * its file and on the terminal, a face it is always shown in, its Unicode
 * properties as describe-char-unidata-list names them, and the overlays
 * and text properties there.
 */
export function describeChar(pos: number): void {
  if (pos >= e8.pointMax()) e8.signal("error", "No character follows specified position");
  const char = e8.charAfter(pos)!;
  const code = char.codePointAt(0)!;
  const propCharset = e8.getTextProperty(pos, "charset");
  let charset = typeof propCharset === "string" ? propCharset : (e8.charCharset(char) ?? "unicode");
  let codePoint = e8.encodeChar(char, charset);
  if (codePoint === undefined) {
    charset = e8.charCharset(char) ?? "unicode";
    codePoint = e8.encodeChar(char, charset);
  }
  let description: string | e8.PropertizedString = code < 128 ? e8.singleKeyDescription(code) : char;
  // An invisible character after one that would reorder what follows, as describe-char adds.
  const fixer =
    code === 0x202a || code === 0x202d
      ? "‬"
      : code === 0x202b || code === 0x202e
        ? "‬‎"
        : code >= 0x2066 && code <= 0x2068
          ? "⁩"
          : ["R", "AL"].includes(String(e8.getCharCodeProperty(code, "bidi-class")))
            ? "‎"
            : "";
  const plain = description;
  if (fixer !== "") description = e8.concat(plain, e8.propertize(fixer, { invisible: true }));
  const begin = e8.pointMin() + 1;
  const end = e8.pointMax() + 1;
  const total = e8.bufferSize();
  const at = pos + 1;
  const percent = roundEven((100 * (at - 1)) / Math.max(total, 1));
  const hscroll = e8.windowHscroll() === 0 ? "" : `, Hscroll: ${e8.windowHscroll()}`;
  const col = e8.currentColumn();
  const position =
    begin !== 1 || end !== total + 1
      ? `${at} of ${total} (${percent}%), restriction: <${begin}-${end}>, column: ${col}${hscroll}`
      : at === end
        ? `${at} of ${total} (EOB), column: ${col}${hscroll}`
        : `${at} of ${total} (${percent}%), column: ${col}${hscroll}`;
  const shown = e8.propertize(plain, e8.textPropertiesAt(pos));
  const rows: Row[] = [
    ["position", position],
    ["character", e8.concat(description, " (displayed as ", shown, `) (codepoint ${code}, #o${code.toString(8)}, #x${code.toString(16)})`)],
    ["charset", charset, `(${String(e8.charsetPlist(charset)[":docstring"] ?? charset)})`],
  ];
  if (codePoint !== undefined) rows.push(["code point in charset", `0x${codePoint.toString(16).toUpperCase().padStart(codePoint < 256 ? 2 : 4, "0")}`]);
  const script = e8.charScript(code);
  if (script !== undefined) rows.push(["script", script]);
  // The raw descriptor, as syntax-after gives it, described in a scratch buffer.
  const descriptor = e8.syntaxEntry(char);
  const raw = descriptor === undefined ? null : (e8.stringToSyntax(descriptor) ?? null);
  const scratch = e8.getBufferCreate(" *describe-char*");
  const syntax = e8.withCurrentBuffer(scratch, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    internalDescribeSyntaxValue(raw as e8.Value);
    const text = e8.bufferText();
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    return text;
  });
  rows.push(["syntax", syntax]);
  // No row where it has none, as describe-char-categories gives nothing.
  const mnemonics = e8.categorySetMnemonics(e8.charCategorySet(code));
  if (mnemonics !== "") rows.push([
    "category",
    e8.concat(
          ...[...mnemonics].flatMap((x, i) => {
            const doc = e8.categoryDocstring(x) ?? "";
            const nl = doc.indexOf("\n");
            const shownDoc = nl < 0 ? doc : e8.propertize(doc.slice(0, nl), { "help-echo": doc.slice(nl + 1) });
            return i === 0 ? [`${x}:`, shownDoc] : [", ", `${x}:`, shownDoc];
          }),
        ),
  ]);
  const name = code === 7 ? "BELL (BEL)" : charToName(code);
  rows.push([
    "to input",
    name !== undefined && ucsNames().has(name) ? `type "C-x 8 RET ${code.toString(16)}" or "C-x 8 RET ${name}"` : `type "C-x 8 RET ${code.toString(16)}"`,
  ]);
  rows.push(["buffer code", bufferCode(code)]);
  const coding = e8.variable("buffer-file-coding-system");
  if (typeof coding === "string") {
    const encoded = encodeCodingChar(char, coding);
    rows.push(
      encoded === undefined
        ? ["file code", "not encodable by coding system", coding]
        : ["file code", encodedStringDescription(encoded, coding), `(encoded by coding system ${coding})`],
    );
  }
  const display = charDisplay(pos, char);
  rows.push([
    "display",
    e8.displayGraphicP()
      ? display === undefined
        ? "no font available"
        : `by this font (glyph code):\n    ${display}`
      : display === undefined
        ? "not encodable for terminal"
        : `terminal code ${display}`,
  ]);
  const nobreak = truthy(e8.variable("nobreak-char-display") ?? true);
  const face =
    truthy(e8.variable("show-trailing-whitespace") ?? null) && e8.lookingAt("[ \t]+$", pos)
      ? "trailing-whitespace"
      : nobreak && code > 127 && e8.getCharCodeProperty(code, "general-category") === "Zs"
        ? "nobreak-space"
        : nobreak && [0xad, 0x2010, 0x2011].includes(code)
          ? "escape-glyph"
          : code < 32 && code !== 9 && code !== 10
            ? "escape-glyph"
            : undefined;
  if (face !== undefined) rows.push(["hardcoded face", button(face, ["face", face])]);
  const unidata = e8.variable("describe-char-unidata-list");
  const all = [...e8.charCodePropertyNames()].reverse();
  const properties = unidata === true ? all : Array.isArray(unidata) ? unidata.map(String) : [];
  // Not a control character's decomposition from a list, as Emacs leaves it out; t shows all.
  const shownProperties = unidata !== true && code < 32 ? properties.filter((p) => p !== "decomposition") : properties;
  const textProps = textPropertiesDescription(pos);
  const width = Math.max(...rows.map(([label]) => label.length));
  withHelpWindow(() => {
    for (const [label, ...columns] of rows) {
      e8.insert(`${label.padStart(width)}:`);
      for (const column of columns) {
        if (typeof column === "string" && column.length === 0) continue;
        e8.insert(" ");
        e8.insert(column);
      }
      e8.insert("\n");
    }
    e8.insert(properties.length === 0 ? "\nCharacter code properties are not shown: " : "\nCharacter code properties: ");
    e8.insert(button("customize what to show", ["call", "customize-variable", "describe-char-unidata-list"]));
    e8.insert("\n");
    for (const property of shownProperties) {
      const value = e8.getCharCodeProperty(code, property);
      if (value === null || value === undefined) continue;
      const desc = propertyDescription(property, value);
      e8.insert(desc === undefined ? `  ${property}: ${princ(value)}\n` : `  ${property}: ${princ(value)} (${desc})\n`);
    }
    for (const part of textProps) e8.insert(part);
  });
}

e8.defineCommand({
  name: "describe-char",
  doc:
    "Describe the character after point: its position and code, charset, script, syntax and categories, how to type it, " +
    "how the buffer, its file and the display hold it, its Unicode properties, and the text properties and overlays there.",
  params: [{ name: "pos", kind: "point" }],
  run: (pos: number) => describeChar(pos),
});

/**
 * Shows the overlays and text properties at `pos`, as
 * describe-text-properties; "This is plain text." where there are none.
 */
export function describeTextProperties(pos: number): void {
  if (pos >= e8.pointMax()) e8.signal("error", "No character follows specified position");
  if (Object.keys(e8.textPropertiesAt(pos)).length === 0 && e8.overlaysAt(pos).length === 0) {
    e8.message("This is plain text.");
    return;
  }
  const parts = textPropertiesDescription(pos);
  withHelpWindow(() => {
    e8.insert(`Text content at position ${pos + 1}:\n\n`);
    for (const part of parts) e8.insert(part);
  });
}

e8.defineCommand({
  name: "describe-text-properties",
  doc: "Describe the overlays and text properties of the character after point.",
  params: [{ name: "pos", kind: "point" }],
  run: (pos: number) => describeTextProperties(pos),
});
