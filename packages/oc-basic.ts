// The basic citation processor, after Org's oc-basic.el: bibliographies
// in BibTeX (.bibtex), biblatex (.bib) and CSL-JSON (.json) files;
// citations exported in author-year form, or numbered, with the styles
// author, noauthor, nocite, note, numeric and text and their caps and bare
// variants; bibliographies printed in author-year or numeric form; keys
// fontified, unknown ones as errors with suggestions; C-c C-o on a key
// visiting its entry; and C-c C-x @ completing keys from the entries'
// authors, years and titles. Like Org's, it is a proof of concept and a
// fall-back.
//
// BibTeX files are read by a parser of its own, where Org uses Emacs's
// bibtex.el: entries, @string macros (and the months), {braced} and
// "quoted" values joined with #, numbers; a file with a syntax error or
// two entries of one key is passed over, as Org's bibtex-validate fails.

import {

  boundaries,
  capitalize,
  concat,
  emphasize,
  exportFunctions,
  getReferences,
  insideFootnoteP,
  keyBoundaries,
  keyNumber,
  listBibliographyFiles,
  makeInsertProcessor,
  makeParagraph,
  mainAffixes,
  mapconcat,
  registerProcessor,
  stableSort,
  supportedStyles,
  symbolString,
  adjustNote,
  wrapCitation,
} from "oc";
import { contents, create, type Datum, type Node, property } from "org-element-ast";
import { interpretData, parseSecondaryString } from "org-element";


type Info = { [key: string]: any };
/** A bibliography entry: its fields and their values, in the file's order, as oc-basic's alists. */
type Entry = [string, unknown][];

e8.defineVariable({ name: "org-cite-basic-sorting-field", value: e8.intern("author"), doc: "Field used to sort bibliography items as a symbol, or nil." });
e8.defineVariable({ name: "org-cite-basic-author-year-separator", value: ", ", doc: "String used to separate cites in an author-year configuration." });
e8.defineVariable({ name: "org-cite-basic-max-key-distance", value: 2, doc: "Maximum (Levenshtein) distance between a wrong key and its suggestions." });
e8.defineVariable({ name: "org-cite-basic-author-column-end", value: 25, doc: "Column where author field ends in completion table, as an integer." });
e8.defineVariable({ name: "org-cite-basic-column-separator", value: "  ", doc: "Column separator in completion table, as a string." });
e8.defineVariable({ name: "org-cite-basic-mouse-over-key-face", value: e8.intern("highlight"), doc: "Face used when mouse is over a citation key." });

const v = (name: string): e8.Value => e8.variable(name) ?? null;

// Reading bibliographies

/** A CSL-JSON file's entries, by key, as org-cite-basic--parse-json. */
function parseJson(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const items = e8.jsonParseString(text) as any[];
  for (const item of Array.isArray(items) ? items : []) {
    const entry: Entry = [];
    for (const [field, value] of Object.entries(item as Record<string, any>)) {
      if (field === "author" || field === "editor") {
        // People's family and given names, joined with "and" as BibTeX joins them.
        const people = Array.isArray(value) ? value : [];
        entry.push([field, people.map((p: any) => `${p?.family ?? ""} ${p?.given ?? ""}`).join(" and ")]);
      } else if (field === "issued") {
        const date = value?.["date-parts"] ?? value?.literal ?? value?.raw;
        let year: string;
        if (Array.isArray(date)) {
          const y = Array.isArray(date[0]) ? date[0][0] : undefined;
          if (typeof y === "number") year = String(y);
          else if (typeof y === "string") year = y;
          else e8.signal("error", `First element of CSL-JSON date-parts should be a number or string, got ${typeof y}: ${JSON.stringify(y)}`);
        } else if (typeof date === "string") year = /\d{4}/.exec(date)?.[0] ?? date;
        else e8.signal("error", `Unknown CSL-JSON date format: ${JSON.stringify(value)}`);
        entry.push(["year", year!]);
      } else entry.push([field, value]);
    }
    entries.set(String(item.id), entry);
  }
  return entries;
}

const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", oct: "October", nov: "November", dec: "December",
};

class BibError extends Error {}

/**
 * A BibTeX file's entries, by key, each with its type, key and fields,
 * names in lower case and values with their delimiters taken off, macros
 * expanded and runs of blanks made one space, as
 * org-cite-basic--parse-bibtex reads them through bibtex.el.
 */
function parseBibtex(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const strings = new Map<string, string>(Object.entries(MONTHS));
  let i = 0;
  const fail = (): never => {
    throw new BibError(`at ${i}`);
  };
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const braced = (): string => {
    // At "{": to its balanced "}".
    let depth = 0;
    const start = i + 1;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return text.slice(start, i++);
    }
    return fail();
  };
  const quoted = (): string => {
    let depth = 0;
    const start = ++i;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      else if (text[i] === '"' && depth === 0) return text.slice(start, i++);
    }
    return fail();
  };
  const value = (): string => {
    let out = "";
    for (;;) {
      skipSpace();
      if (text[i] === "{") out += braced();
      else if (text[i] === '"') out += quoted();
      else {
        const m = /^[^\s,#{}"()=]+/.exec(text.slice(i));
        if (!m) fail();
        i += m![0].length;
        out += /^\d+$/.test(m![0]) ? m![0] : (strings.get(m![0].toLowerCase()) ?? m![0]);
      }
      skipSpace();
      if (text[i] !== "#") return out;
      i++;
    }
  };
  for (;;) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    i = at + 1;
    const typeMatch = /^[ \t]*([A-Za-z][\w-]*)[ \t\n]*([{(])/.exec(text.slice(i));
    if (!typeMatch) continue;
    const type = typeMatch[1];
    const close = typeMatch[2] === "{" ? "}" : ")";
    i += typeMatch[0].length;
    const kind = type.toLowerCase();
    if (kind === "comment") {
      i -= 1;
      if (close === "}") braced();
      continue;
    }
    if (kind === "preamble") {
      value();
      skipSpace();
      if (text[i] !== close) fail();
      i++;
      continue;
    }
    if (kind === "string") {
      skipSpace();
      const name = /^[^\s=,{}]+/.exec(text.slice(i));
      if (!name) fail();
      i += name![0].length;
      skipSpace();
      if (text[i] !== "=") fail();
      i++;
      strings.set(name![0].toLowerCase(), value());
      skipSpace();
      if (text[i] !== close) fail();
      i++;
      continue;
    }
    skipSpace();
    const keyMatch = /^[^\s,]*/.exec(text.slice(i))!;
    const key = keyMatch[0];
    i += key.length;
    skipSpace();
    const entry: Entry = [["type", type], ["id", key]];
    for (;;) {
      skipSpace();
      if (text[i] === close) {
        i++;
        break;
      }
      if (text[i] !== ",") fail();
      i++;
      skipSpace();
      if (text[i] === close) {
        i++;
        break;
      }
      const field = /^[^\s=,{}"#()]+/.exec(text.slice(i));
      if (!field) fail();
      i += field![0].length;
      skipSpace();
      if (text[i] !== "=") fail();
      i++;
      entry.push([field![0].toLowerCase(), value().replace(/[ \t\n]+/g, " ")]);
    }
    if (entries.has(key)) fail();
    entries.set(key, entry);
  }
  return entries;
}

/** Each file's entries, kept while the file is unchanged, as org-cite-basic--bibliography-cache. */
const bibliographyCache = new Map<string, { modified: number; size: number; entries: Map<string, Entry> }>();

/**
 * The entries of each bibliography file that can be read, as [file,
 * entries], as org-cite-basic--parse-bibliography; kept in the export's
 * information for the export.
 */
export function parseBibliography(info?: Info): [string, Map<string, Entry>][] {
  if (info && "cite-basic/bibliography" in info) return info["cite-basic/bibliography"];
  const results: [string, Map<string, Entry>][] = [];
  for (const name of listBibliographyFiles()) {
    const file = e8.fileTruename(e8.expandFileName(name));
    if (!e8.fileReadableP(file)) continue;
    const attributes = e8.fileAttributes(file);
    const cached = bibliographyCache.get(file);
    let entries = cached && attributes && cached.modified === attributes.modified && cached.size === attributes.size ? cached.entries : undefined;
    if (!entries) {
      try {
        const text = readFile(file);
        const extension = /\.([^./]+)$/.exec(file)?.[1];
        if (extension === "json") entries = parseJson(text);
        else if (extension === "bib" || extension === "bibtex") entries = parseBibtex(text);
        // Org's user-error for an unknown extension, and a malformed file, are caught, and the file passed over.
        else continue;
      } catch (e) {
        if (e instanceof BibError || e8.errorConditions(e).length > 0) continue;
        throw e;
      }
      if (attributes) bibliographyCache.set(file, { modified: attributes.modified, size: attributes.size, entries });
    }
    results.push([file, entries]);
  }
  if (info) info["cite-basic/bibliography"] = results;
  return results;
}

/** A file's text, decoded as its coding says. */
function readFile(file: string): string {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => {
      e8.insertFileContents(file);
      return e8.bufferText();
    });
  } finally {
    e8.call("kill-buffer", name);
  }
}

/** A cited key's number, by the sorting field, as org-cite-basic--key-number. */
function basicKeyNumber(key: string, info: Info): number | undefined {
  return keyNumber(key, info, fieldLessP(symbolString(v("org-cite-basic-sorting-field")), info));
}

/** Every key of the bibliography, as org-cite-basic--all-keys. */
export function allKeys(): string[] {
  return parseBibliography().flatMap(([, entries]) => [...entries.keys()]);
}

/** A key's entry, as org-cite-basic--get-entry. */
export function getEntry(key: string, info?: Info): Entry | undefined {
  for (const [, entries] of parseBibliography(info)) {
    const entry = entries.get(key);
    if (entry) return entry;
  }
  return undefined;
}

/**
 * A field's value in an entry, or the entry of a key, as
 * org-cite-basic--get-field: a string, or undefined; a raw string object
 * for a backend derived from LaTeX unless RAW.
 */
function getField(field: string, entryOrKey: Entry | string | undefined, info?: Info, raw = false): string | Node | undefined {
  const entry = typeof entryOrKey === "string" ? getEntry(entryOrKey, info) : entryOrKey;
  const value = entry?.find(([f]) => f === field)?.[1];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") e8.signal("error", `Non-string bibliography field value: ${JSON.stringify(value)}`);
  if (!raw && info && exportFunctions().derivedBackendP(info["back-end"], "latex")) return exportFunctions().rawString(value as string);
  return value as string;
}

/** Family names from full names, "family, given" shortened, as org-cite-basic--shorten-names. */
function shortenNames(names: string | Node | undefined): string | Node | undefined {
  if (names === undefined) return undefined;
  const raw = typeof names !== "string";
  const s = typeof names === "string" ? names : contents(names).join("");
  const short = s
    .split(" and ")
    .map((name) => (name.length === 1 ? name.split(/[ \f\t\n\r\v]+/).filter((x) => x !== "").slice(1).join("") : name.split(", ")[0]))
    .join(", ");
  return raw ? exportFunctions().rawString(short) : short;
}

/** The letters a number stands for, for disambiguating years, as org-cite-basic--number-to-suffix. */
export function numberToSuffix(n: number): string {
  let result: number[] = [];
  for (;;) {
    result.unshift(n % 26);
    n = Math.floor(n / 26);
    if (n === 0) break;
    if (n < 27) {
      result.unshift(n - 1);
      break;
    }
    if (n === 27) {
      result = [0, 0, ...result];
      break;
    }
  }
  return String.fromCharCode(...result.map((x) => 97 + x));
}

/** An entry's author, or its editor, as org-cite-basic--get-author. */
function getAuthor(entryOrKey: Entry | string | undefined, info?: Info, raw = false): string | Node | undefined {
  return getField("author", entryOrKey, info, raw) ?? getField("editor", entryOrKey, info, raw);
}

/**
 * An entry's year, from its year field or the start of its date, with a
 * letter after it for the second and later entries of one author and
 * year, unless NO-SUFFIX, as org-cite-basic--get-year.
 */
function getYear(entryOrKey: Entry | string | undefined, info: Info | undefined, noSuffix = false): string | undefined {
  const author = getAuthor(entryOrKey, info, true) as string | undefined;
  let year = getField("year", entryOrKey, info, true) as string | undefined;
  if (year === undefined) {
    const date = getField("date", entryOrKey, info, true);
    year = typeof date === "string" ? /^(\d{4})(?:$|\D)/.exec(date)?.[1] : undefined;
  }
  const key = typeof entryOrKey === "string" ? entryOrKey : (entryOrKey?.find(([f]) => f === "id")?.[1] as string | undefined);
  if (!info) return year;
  const cache: [string | undefined, string | undefined, [string | undefined, string][]][] = (info["cite-basic/author-date-cache"] ??= []);
  const entry = cache.find(([a, y]) => a === author && y === year);
  if (!entry) {
    cache.unshift([author, year, [[key, ""]]]);
    return year;
  }
  const alist = entry[2];
  let suffix = alist.find(([k]) => k === key)?.[1];
  if (suffix === undefined) {
    suffix = numberToSuffix(alist.length - 1);
    alist.unshift([key, suffix]);
  }
  return noSuffix ? year : (year ?? "") + suffix;
}

/**
 * Data printed as BibTeX writes it, as org-cite-basic--print-bibtex-string:
 * outside LaTeX, the text in it parsed for LaTeX fragments and entities,
 * and the braces that remain taken out. A string is processed; of a
 * secondary string, only the text within its objects, as Org's
 * org-element-set reaches no further.
 */
function printBibtexString(element: Datum | Datum[], info?: Info): Datum | Datum[] {
  if (info && exportFunctions().derivedBackendP(info["back-end"], "latex")) return element;
  const fix = (s: string): Datum[] =>
    parseSecondaryString(s, ["latex-fragment", "entity"]).map((d) => (typeof d === "string" ? d.replace(/[{}]/g, "") : d));
  const walk = (node: Node): void => {
    node.contents = node.contents.flatMap((c) => {
      if (typeof c === "string") return fix(c).map((d) => (typeof d !== "string" ? ((d.parent = node), d) : d));
      walk(c);
      return [c];
    });
  };
  if (typeof element === "string") {
    const anonymous = create("anonymous", {}, element);
    walk(anonymous);
    return anonymous;
  }
  for (const d of Array.isArray(element) ? element : [element]) if (typeof d !== "string") walk(d);
  return element;
}

/** An entry printed in a bibliography style, as org-cite-basic--print-entry. */
function printEntry(entry: Entry, style: string | undefined, info?: Info): Datum | Datum[] {
  const author = getAuthor(entry, info);
  const title = getField("title", entry, info);
  const from = getField("publisher", entry, info) ?? getField("journal", entry, info) ?? getField("institution", entry, info) ?? getField("school", entry, info);
  let data: Datum[];
  if (style === "plain") {
    const year = getYear(entry, info, true);
    data = concat(shortenNames(author), ". ", title, from !== undefined ? [", ", from] : undefined, ", ", year, ".");
  } else if (style === "numeric") {
    const n = basicKeyNumber(entry.find(([f]) => f === "id")![1] as string, info!);
    const year = getYear(entry, info, true);
    data = concat(`[${n}] `, author, ", ", emphasize("italic", title), from !== undefined ? [", ", from] : undefined, ", ", year, ".");
  } else {
    // Author-year by default, the years told apart.
    const year = getYear(entry, info);
    data = concat(author, " (", year, "). ", emphasize("italic", title), from !== undefined ? [", ", from] : undefined, ".");
  }
  return printBibtexString(data, info);
}

// Activation

/** The keys within the maximum distance of KEY, as org-cite-basic--close-keys. */
function closeKeys(key: string, keys: string[]): string[] {
  const max = Number(v("org-cite-basic-max-key-distance") ?? 2);
  return keys.filter((k) => e8.stringDistance(k, key) <= max);
}

/** Puts a keymap on a key: C-c C-o's on a known one, else replacing it with a suggestion or inserting, as org-cite-basic--set-keymap. */
function setKeymap(beg: number, end: number, suggestions: string[] | "all" | undefined): void {
  const km = e8.makeSparseKeymap();
  let command: string;
  if (suggestions === undefined) command = "org-open-at-point";
  else if (suggestions === "all") command = "org-cite-insert";
  else {
    const choices = suggestions;
    command = e8.defineCommand({
      name: `org-cite-basic--substitute-${beg}`,
      doc: "Replace the citation key with a suggestion.",
      run: () =>
        e8.saveExcursion(() => {
          e8.deleteRegion(beg, end);
          e8.gotoChar(beg);
          e8.insert("@" + (choices.length === 1 ? choices[0] : e8.completingRead("Did you mean: ", choices, { requireMatch: true })));
        }),
    }) as unknown as string;
  }
  e8.defineKey(km, "<mouse-1>", command as any);
  e8.putTextProperty(beg, end, "keymap", km);
}

/**
 * Fontifies a citation with org-cite, a known key with org-cite-key and
 * its entry as help-echo, an unknown one with error and the keys close to
 * it, as org-cite-basic-activate.
 */
function basicActivate(citation: Node): void {
  const [beg, end] = boundaries(citation);
  const keys = allKeys();
  e8.putTextProperty(beg, end, "font-lock-multiline", true);
  e8.addFaceTextProperty(beg, end, "org-cite");
  for (const reference of getReferences(citation)) {
    const [b, e] = keyBoundaries(reference);
    const key = String(property("key", reference));
    e8.putTextProperty(b, e, "mouse-face", v("org-cite-basic-mouse-over-key-face"));
    if (keys.includes(key)) {
      const entry = getEntry(key);
      const help = interpretData(printEntry(entry!, "plain"));
      e8.addFaceTextProperty(b, e, "org-cite-key");
      e8.putTextProperty(b, e, "help-echo", help);
      setKeymap(b, e, undefined);
    } else {
      e8.addFaceTextProperty(b, e, "error");
      const close = closeKeys(key, keys);
      if (close.length > 0) e8.putTextProperty(b, e, "help-echo", `Suggestions (mouse-1 to substitute): ${close.join(" ")}`);
      setKeymap(b, e, close.length > 0 ? close : "all");
    }
  }
}

// Export

/**
 * A citation in author-year form, as org-cite-basic--format-author-year:
 * FORMAT-CITE given the global prefix, the references and the global
 * suffix, FORMAT-REF each reference's prefix, author, year and suffix.
 */
function formatAuthorYear(
  citation: Node,
  formatCite: (p: Datum[] | undefined, c: Datum[] | undefined, s: Datum[] | undefined) => Datum[],
  formatRef: (p: Datum[] | undefined, a: Datum, y: string, s: Datum[] | undefined) => Datum[],
  info: Info,
): string {
  const refs = mapconcat(
    (ref: Node) => {
      const k = String(property("key", ref));
      return formatRef(property("prefix", ref), getAuthor(k, info) ?? "??", getYear(k, info) ?? "????", property("suffix", ref));
    },
    getReferences(citation),
    String(v("org-cite-basic-author-year-separator") ?? ", "),
  );
  return exportFunctions().data(formatCite(property("prefix", citation), refs, property("suffix", citation)), info);
}

/** A citation's references' numbers, runs of three or more as ranges, as org-cite-basic--citation-numbers. */
function citationNumbers(citation: Node, info: Info): string {
  const numbers = getReferences(citation, true)
    .map((k) => basicKeyNumber(k, info) ?? 0)
    .sort((a, b) => a - b);
  let last = numbers[0];
  const result: string[] = [String(numbers.shift())];
  while (numbers.length > 0) {
    const current = numbers.shift()!;
    const next = numbers[0];
    if (next !== undefined && current === last + 1 && current === next - 1) {
      if (result[result.length - 1] !== "-") result.push("-");
    } else if (result[result.length - 1] === "-") result.push(String(current));
    else result.push(`, ${current}`);
    last = current;
  }
  return result.join("");
}

/**
 * Compares two strings as org-string< with IGNORE-CASE does in Emacs on
 * macOS: by code points, case and all, as its string-collate-lessp
 * compares there, a missing value as the symbol nil's name.
 */
function stringLess(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "nil") < (b ?? "nil");
}

/** A predicate comparing two keys' FIELD values, as org-cite-basic--field-less-p. */
function fieldLessP(field: string | undefined, info: Info): ((a: string, b: string) => boolean) | undefined {
  if (!field) return undefined;
  return (a, b) => stringLess(getField(field, a, info, true) as string | undefined, getField(field, b, info, true) as string | undefined);
}

/** Keys sorted by the sorting field, as org-cite-basic--sort-keys. */
function sortKeys(keys: string[], info: Info): string[] {
  const predicate = fieldLessP(symbolString(v("org-cite-basic-sorting-field")), info);
  return predicate ? stableSort(keys, predicate) : keys;
}

/** A variant's being bare or in capitals, as the export's has-variant-p. */
function hasVariant(variant: string | undefined, type: "bare" | "caps"): boolean {
  return (type === "bare" ? ["bare", "bare-caps", "b", "bc"] : ["caps", "bare-caps", "c", "bc"]).includes(variant ?? "");
}

/** A citation exported in its style, as org-cite-basic-export-citation. */
function exportCitation(citation: Node, style: [string | undefined, string | undefined], _backend: unknown, info: Info): string | undefined {
  const [name, variant] = style;
  const cap = (a: Datum, on: boolean): Datum => (on ? capitalize(a) : a);
  if (name === "author" || name === "a") {
    const caps = variant === "caps" || variant === "c";
    return formatAuthorYear(citation, (p, c, s) => concat(p, c, s), (prefix, author, _y, suffix) => concat(prefix, cap(author, caps), suffix), info);
  }
  if (name === "noauthor" || name === "na") {
    const bare = hasVariant(variant, "bare");
    return formatAuthorYear(
      citation,
      (prefix, c, suffix) => concat(bare ? undefined : "(", prefix, c, suffix, bare ? undefined : ")"),
      (prefix, _a, year, suffix) => concat(prefix, year, suffix),
      info,
    );
  }
  if (name === "nocite" || name === "n") return undefined;
  if (name === "text" || name === "note" || name === "t" || name === "ft") {
    if ((name === "note" || name === "ft") && !insideFootnoteP(citation)) {
      adjustNote(citation, info);
      wrapCitation(citation, info);
    }
    const bare = hasVariant(variant, "bare");
    const caps = hasVariant(variant, "caps");
    return formatAuthorYear(
      citation,
      (p, c, s) => concat(p, c, s),
      (p, a, y, s) => concat(p, cap(a, caps), bare ? " " : " (", y, bare ? undefined : ")", s),
      info,
    );
  }
  if (name === "numeric" || name === "nb") {
    // Global affixes with several references, the local ones ignored.
    const [prefix, suffix] = mainAffixes(citation);
    return exportFunctions().data(concat("(", prefix, citationNumbers(citation, info), suffix, ")"), info);
  }
  const bare = hasVariant(variant, "bare");
  const caps = hasVariant(variant, "caps");
  return formatAuthorYear(
    citation,
    (p, c, s) => concat(bare ? undefined : "(", p, c, s, bare ? undefined : ")"),
    (p, a, y, s) => concat(p, cap(a, caps), ", ", y, s),
    info,
  );
}

/** The bibliography, an entry a paragraph, as org-cite-basic-export-bibliography. */
function exportBibliography(keys: string[], _files: string[], style: string | undefined, _props: e8.Value[], backend: any, info: Info): string {
  const { data, derivedBackendP, rawString } = exportFunctions();
  return sortKeys(keys, info)
    .map((k) => getEntry(k, info))
    .filter((e): e is Entry => e !== undefined)
    .map((entry) => data(makeParagraph(derivedBackendP(backend, "latex") ? rawString("\\noindent\n") : undefined, printEntry(entry, style, info)), info))
    .join("\n");
}

// Following

/** Visits the bibliography entry of a reference's key, or of a key of a citation chosen, as org-cite-basic-goto. */
function goto(datum: Node): void {
  let key: string;
  if (datum.type === "citation-reference") key = String(property("key", datum));
  else {
    const keys = getReferences(datum, true);
    key = keys.length === 1 ? keys[0] : e8.completingRead("Select citation key: ", keys, { requireMatch: true });
  }
  const found = parseBibliography().find(([, entries]) => entries.has(key));
  if (!found) e8.userError(`Cannot find citation key: ${JSON.stringify(key)}`);
  const file = found![0];
  e8.call("find-file", file);
  e8.gotoChar(e8.pointMin());
  const quoted = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\.json$/.test(file)) {
    const at = e8.reSearchForward(`"id":[[ \t]]*"${emacsQuote(key)}"`);
    if (at !== undefined) {
      const text = e8.bufferText(e8.pointMin(), e8.point());
      e8.gotoChar(text.lastIndexOf("{"));
    }
  } else {
    // As bibtex-search-entry: the start of the entry.
    const m = new RegExp(`^[ \\t]*@[A-Za-z]+[ \\t]*[{(][ \\t\\n]*${quoted}[ \\t\\n]*,`, "m").exec(e8.bufferText());
    if (m) e8.gotoChar(m.index + m[0].length - m[0].trimStart().length);
  }
}

/** A string quoted for an Emacs regexp, as regexp-quote. */
function emacsQuote(s: string): string {
  return s.replace(/[[*.\\?+^$]/g, "\\$&");
}

// Insertion

/** A style chosen among those the export processors know, as org-cite-basic--complete-style. */
function completeStyle(): string {
  const styles = supportedStyles().map(([[style]]) => style);
  return styles.length === 1 ? styles[0] : e8.completingRead('Style ("" for default): ', styles, { requireMatch: true });
}

/** A string cut or padded to WIDTH columns, as truncate-string-to-width with padding. */
function toWidth(s: string, width: number): string {
  let out = "";
  let w = 0;
  for (const c of s) {
    const cw = e8.stringWidth(c);
    if (w + cw > width) break;
    out += c;
    w += cw;
  }
  return out + " ".repeat(Math.max(0, width - w));
}

/** Each completion of a key, its author, year and title, and the key, as org-cite-basic--key-completion-table. */
function keyCompletionTable(): Map<string, string> | undefined {
  const entries = parseBibliography();
  if (entries.length === 0) return undefined;
  const table = new Map<string, string>();
  const column = Number(v("org-cite-basic-author-column-end") ?? 25);
  const sep = String(v("org-cite-basic-column-separator") ?? "  ");
  const info = { "cite-basic/bibliography": entries };
  for (const key of allKeys()) {
    const entry = getEntry(key, info);
    const author = getAuthor(entry, undefined, true) as string | undefined;
    const date = getYear(entry, undefined, true);
    const completion =
      (author !== undefined ? toWidth(author.replace(/ and /g, "; "), column) : " ".repeat(column)) +
      sep +
      (date ?? "").padStart(4) +
      sep +
      String(getField("title", entry, undefined, true) ?? "");
    table.set(completion, key);
  }
  return table.size > 0 ? table : undefined;
}

/** A key read with completion, or keys until an empty answer with MULTIPLE, as org-cite-basic--complete-key. */
function completeKey(multiple: boolean): string | string[] | undefined {
  const table = keyCompletionTable() ?? e8.userError("No bibliography set");
  const choices = [...table.keys()];
  const prompt = (text: string) => e8.completingRead(text, choices, { requireMatch: true });
  if (!multiple) {
    const key = table.get(prompt("Key: "));
    return key !== undefined && /[^ \t\n\r]/.test(key) ? key : undefined;
  }
  const keys: string[] = [];
  const build = () => (keys.length > 0 ? `Key (empty input exits) ${keys.join(";")}: ` : "Key (empty input exits): ");
  for (let key = prompt(build()); /[^ \t\n\r]/.test(key); key = prompt(build())) keys.push(table.get(key)!);
  // Most recent first, as Org pushes them.
  return [...keys].reverse();
}

registerProcessor("basic", {
  activate: basicActivate,
  exportCitation,
  exportBibliography,
  follow: (datum) => goto(datum),
  insert: makeInsertProcessor(completeKey, completeStyle),
  citeStyles: [
    [["author", "a"], ["caps", "c"]],
    [["noauthor", "na"], ["bare", "b"]],
    [["nocite", "n"]],
    [["note", "ft"], ["bare-caps", "bc"], ["caps", "c"]],
    [["numeric", "nb"]],
    [["text", "t"], ["bare-caps", "bc"], ["caps", "c"]],
    [["nil"], ["bare", "b"], ["bare-caps", "bc"], ["caps", "c"]],
  ],
});

