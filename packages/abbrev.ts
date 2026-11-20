// Abbreviations, after Emacs's abbrev.el: a word that expands into a
// phrase, kept in the global table or the major mode's. C-x a g and
// C-x a l define one from the words before point, C-x a i g and C-x a i l
// from the word before point, C-x ' expands the one before point, and in
// abbrev-mode typing a character that ends a word expands it. A capital in
// the abbreviation capitalizes the expansion.

import { keyChar } from "simple";

e8.defineVariable({ name: "only-global-abbrevs", doc: "Whether the abbrev commands define only global abbrevs, not ones for the major mode.", value: false });
e8.defineVariable({ name: "abbrev-all-caps", doc: "Whether an abbrev typed in capitals expands all in capitals, rather than with each word capitalized.", value: false });
e8.defineVariable({ name: "abbrev-file-name", doc: "Default name of file from which to read and where to save abbrevs: abbrev_defs in the configuration directory.", value: null });
e8.defineVariable({ name: "save-abbrevs", doc: "Non-nil means save word abbrevs too when files are saved.\nIf `silently', don't ask the user before saving.", value: true });
e8.defineVariable({ name: "abbrevs-changed", doc: "Non-nil if any word abbrevs were defined or altered.\nThis causes `save-some-buffers' to offer to save the abbrevs.", value: false });

/** An abbrev: its expansion, how often it was used, the function run after expanding it, and whether its case is fixed. */
interface Abbrev {
  expansion: string;
  count: number;
  hook?: string;
  caseFixed?: boolean;
}

/** The abbrev tables, by name, each abbrev's name, as defined, to the abbrev. */
const tables = new Map<string, Map<string, Abbrev>>();

const GLOBAL = "global-abbrev-table";
/** The major mode's table, as local-abbrev-table names it. */
const localTable = (): string => `${String(e8.variable("major-mode"))}-abbrev-table`;
const table = (name: string) => {
  let t = tables.get(name);
  if (t === undefined) {
    t = new Map();
    tables.set(name, t);
  }
  return t;
};

/**
 * Defines an abbrev under its name as given, as define-abbrev: a null
 * expansion undefines it. Anything but the same expansion and hook again
 * marks the abbrevs changed, for saving them.
 */
export function defineAbbrev(tableName: string, name: string, expansion: string | null, count = 0, props: { hook?: string; caseFixed?: boolean } = {}): void {
  const old = tables.get(tableName)?.get(name);
  if (!(old !== undefined && expansion !== null && old.expansion === expansion && old.hook === props.hook)) e8.setDefault("abbrevs-changed", true);
  if (expansion === null) table(tableName).delete(name);
  else table(tableName).set(name, { expansion, count, ...props });
}

/** The name an abbrev is under in one table, the name as given or else in lower case, as abbrev--symbol finds it. */
function abbrevKey(name: string, tableName: string): string | undefined {
  const t = tables.get(tableName);
  if (t === undefined) return undefined;
  if (t.has(name)) return name;
  const lower = name.toLowerCase();
  return t.get(lower)?.caseFixed ? undefined : t.has(lower) ? lower : undefined;
}

/**
 * The tables a table inherits from: a mode's table has the tables of the
 * modes it is built on, as define-derived-mode makes them its :parents.
 */
function withParents(tableName: string): string[] {
  const m = /^(.*-mode)-abbrev-table$/.exec(tableName);
  return m === null ? [tableName] : e8.derivedModeAllParents(m[1]!).map((mode) => `${mode}-abbrev-table`);
}

/** The table and name an abbrev is found under, looking in the tables' parents too, as abbrev-symbol. */
function abbrevSymbol(name: string, tableNames: string[]): { table: string; key: string } | undefined {
  for (const t of tableNames.flatMap(withParents)) {
    const key = abbrevKey(name, t);
    if (key !== undefined) return { table: t, key };
  }
  return undefined;
}

/** What an abbrev expands into in a table or those it inherits from, as abbrev-expansion. */
const abbrevExpansion = (name: string, tableName: string): string | undefined => {
  const found = abbrevSymbol(name, [tableName]);
  return found === undefined ? undefined : tables.get(found.table)!.get(found.key)!.expansion;
};

/**
 * The tables to look abbrevs up in: the mode's, then the tables of the
 * modes it is built on, which define-derived-mode makes its parents, then
 * the global one, as abbrev--active-tables and abbrev-symbol go through them.
 */
const activeTables = (): string[] => [localTable(), GLOBAL];

e8.defun("abbrev-expansion", (abbrev: string, tableName?: string) => {
  const found = abbrevSymbol(abbrev, typeof tableName === "string" ? [tableName] : activeTables());
  return found === undefined ? null : tables.get(found.table)!.get(found.key)!.expansion;
});

/** The word before point and the abbrev it names, if any, as abbrev--before-point. */
function abbrevBeforePoint(): { table: string; name: string; key: string; start: number; end: number } | undefined {
  const pos = e8.point();
  return e8.saveExcursion(() => {
    e8.call("backward-word");
    const start = e8.point();
    e8.call("forward-word");
    const end = Math.min(e8.point(), pos);
    if (end <= start) return undefined;
    const name = e8.bufferSubstringNoProperties(start, end);
    const found = abbrevSymbol(name, activeTables());
    return found === undefined ? undefined : { ...found, name, start, end };
  });
}

/** Puts an abbrev's expansion in place of the word, with the case the word had, as abbrev-insert. */
function abbrevInsert(t: string, key: string, name: string, start: number, wordEnd: number): void {
  const entry = tables.get(t)!.get(key)!;
  entry.count++;
  e8.gotoChar(start);
  // Inserted first, so markers at the end, point among them, stay after it.
  e8.insert(entry.expansion);
  const endMarker = e8.makeMarker(e8.point());
  e8.deleteRegion(e8.point(), e8.point() + (wordEnd - start));
  const end = e8.markerPosition(endMarker)!;
  if (name !== name.toLowerCase() && /\p{Lu}/u.test(name)) {
    if (!/\p{Ll}/u.test(name)) {
      // All in capitals: each word capitalized if there are several, else all capitals.
      const severalWords = e8.saveExcursion(() => {
        e8.call("backward-word");
        const last = e8.point();
        return last > start;
      });
      if (e8.variable("abbrev-all-caps") !== true && severalWords) e8.call("upcase-initials-region", start, end);
      else e8.call("upcase-region", start, end);
    } else {
      // Some capitals: the expansion's first initial.
      e8.gotoChar(start);
      e8.skipSyntaxForward("^w", end - 1);
      e8.call("upcase-initials-region", e8.point(), e8.point() + 1);
    }
  }
  e8.gotoChar(e8.markerPosition(endMarker)!);
  e8.deleteMarker(endMarker);
  // Its hook after it, as abbrev-insert calls it.
  if (entry.hook !== undefined && e8.fboundp(entry.hook)) e8.funcall(entry.hook);
}

/** Expands the abbrev before point, if there is one, as expand-abbrev; returns whether it did. */
function expandAbbrev(): boolean {
  const found = abbrevBeforePoint();
  if (found === undefined) return false;
  const pos = e8.point();
  const after = pos - found.end;
  abbrevInsert(found.table, found.key, found.name, found.start, found.end);
  e8.gotoChar(e8.point() + after);
  return true;
}

e8.defineMinorMode({
  name: "abbrev-mode",
  lighter: " Abbrev",
  doc: "Expand abbrevs as they are typed: a character that ends a word expands the word before it if it is an abbrev.",
});

// Typing a character that is not part of a word, after a word, expands it
// first, as self-insert-command does in Emacs.
e8.adviceAdd("self-insert-command", "before", () => {
  if (e8.variable("abbrev-mode") !== true) return;
  const c = keyChar(e8.lastKey() ?? "");
  if (c === undefined || e8.charSyntax(c) === "w") return;
  if (e8.point() === e8.pointMin() || e8.charSyntax(e8.charAfter(e8.point() - 1) ?? "") !== "w") return;
  expandAbbrev();
});

e8.defineCommand({
  name: "expand-abbrev",
  doc: "Expand the abbrev before point, if there is one.",
  run: () => {
    expandAbbrev();
  },
});

/** Defines an abbrev for the words before point, or the region, as add-abbrev; a prefix argument of 0 means the region. */
async function addAbbrev(tableName: string, type: string, arg: e8.PrefixArg): Promise<void> {
  const n = e8.prefixNumericValue(arg);
  const mark = e8.mark();
  let exp: string | undefined;
  if ((arg === null && e8.regionActive() && mark !== undefined) || n === 0) {
    exp = e8.bufferSubstringNoProperties(Math.min(mark!, e8.point()), Math.max(mark!, e8.point()));
  } else if (n > 0) {
    const start = e8.saveExcursion(() => {
      e8.callWithPrefix(-n, "forward-word");
      return e8.point();
    });
    exp = e8.bufferSubstringNoProperties(start, e8.point());
  }
  const name = await e8.readString(exp !== undefined ? `${type} abbrev that expands into "${exp}": ` : `Undefine ${type} abbrev: `);
  const old = abbrevExpansion(name, tableName);
  if (exp === undefined || old === undefined || (await e8.yOrNP(`${name} expands into "${old}"; redefine? `))) {
    defineAbbrev(tableName, name.toLowerCase(), exp ?? null);
  }
}

/** Defines the word before point as an abbrev for an expansion asked for, and expands it, as inverse-add-abbrev. */
async function inverseAddAbbrev(tableName: string, type: string, arg: number): Promise<void> {
  const [start, end] = e8.saveExcursion(() => {
    e8.callWithPrefix(1 - arg, "forward-word");
    const e = e8.point();
    e8.call("backward-word");
    return [e8.point(), e];
  });
  const name = e8.bufferSubstringNoProperties(start, end);
  const exp = await e8.readString(`${type} expansion for "${name}": `);
  const old = abbrevExpansion(name, tableName);
  if (old === undefined || (await e8.yOrNP(`${name} expands into "${old}"; redefine? `))) {
    defineAbbrev(tableName, name.toLowerCase(), exp);
    e8.saveExcursion(() => {
      e8.gotoChar(end);
      expandAbbrev();
    });
  }
}

const modeTable = () => (e8.variable("only-global-abbrevs") === true ? GLOBAL : localTable());

e8.defineCommand({
  name: "add-global-abbrev",
  doc: "Define a global abbrev for the word before point, or that many words, or the region with 0, asking for its name.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => addAbbrev(GLOBAL, "Global", arg),
});
e8.defineCommand({
  name: "add-mode-abbrev",
  doc: "Define an abbrev for the major mode for the word before point, or that many words, or the region with 0, asking for its name.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => addAbbrev(modeTable(), e8.variable("only-global-abbrevs") === true ? "Global" : "Mode", arg),
});
e8.defineCommand({
  name: "inverse-add-global-abbrev",
  doc: "Make the word before point a global abbrev for an expansion asked for, and expand it.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => inverseAddAbbrev(GLOBAL, "Global", arg),
});
e8.defineCommand({
  name: "inverse-add-mode-abbrev",
  doc: "Make the word before point an abbrev for the major mode for an expansion asked for, and expand it.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => inverseAddAbbrev(modeTable(), e8.variable("only-global-abbrevs") === true ? "Global" : "Mode", arg),
});

e8.defineCommand({
  name: "define-global-abbrev",
  doc: "Define a global abbrev, asking for its name and expansion.",
  params: [
    { name: "abbrev", kind: "string", prompt: "Define global abbrev: " },
    { name: "expansion", kind: "string", prompt: "Expansion: " },
  ],
  run: (abbrev: string, expansion: string) => defineAbbrev(GLOBAL, abbrev.toLowerCase(), expansion),
});
e8.defineCommand({
  name: "define-mode-abbrev",
  doc: "Define an abbrev for the major mode, asking for its name and expansion.",
  params: [
    { name: "abbrev", kind: "string", prompt: "Define mode abbrev: " },
    { name: "expansion", kind: "string", prompt: "Expansion: " },
  ],
  run: (abbrev: string, expansion: string) => defineAbbrev(localTable(), abbrev.toLowerCase(), expansion),
});
e8.defineCommand({
  name: "kill-all-abbrevs",
  doc: "Forget every abbrev in every table.",
  run: () => {
    tables.clear();
    e8.setDefault("abbrevs-changed", true);
  },
});

// The abbrev file, as abbrev.el reads and writes it: Lisp that
// define-abbrev-table forms, which E8 reads itself, so a file Emacs wrote
// reads too.

/** The file abbrevs are read from and saved to, as abbrev-file-name: abbrev_defs in the configuration directory by default. */
const abbrevFile = (): string => {
  const named = e8.variable("abbrev-file-name");
  if (typeof named === "string" && named !== "") return named;
  const dir = e8.variable("user-emacs-directory");
  return e8.abbreviateFileName(e8.expandFileName("abbrev_defs", typeof dir === "string" ? dir : "~/.config/e8/"));
};
// Its value once the configuration directory is known, as Emacs's custom-initialize-delay sets it.
e8.addHook("before-init-hook", () => {
  if (typeof e8.defaultValue("abbrev-file-name") !== "string") e8.setDefault("abbrev-file-name", abbrevFile());
});

/** A Lisp datum as the reader gives it: a string, a number, a symbol's name, or a list. */
type Datum = string | number | { symbol: string } | Datum[];

/** The character a \C- or \^ escape makes of another, as Emacs's reader does. */
const control = (c: number): number => (c === 0x3f ? 0x7f : c >= 0x40 && c < 0x80 ? c & 0x1f : c | 0x4000000);

/**
 * Reads Lisp data one at a time, as `read` would, enough for any file of
 * Lisp an abbrev file may be part of: lists, vectors, strings with
 * Emacs's escapes, ?c characters, quoted and backquoted forms, numbers
 * and symbols with \-escaped characters.
 */
function* readLisp(text: string): Generator<Datum> {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== ";") return;
      while (i < text.length && text[i] !== "\n") i++;
    }
  };
  /** The character a backslash escape stands for, i at the character after the backslash. */
  const escape = (inString: boolean): number | undefined => {
    const c = text[i++];
    if (c === undefined) throw new Error("End of file during parsing");
    const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, e: 27, s: 32, d: 127 };
    // \s- is the super modifier, before \s as a space.
    if (c === "s" && text[i] === "-") {
      i++;
      return 0x800000 | (escapeOrChar(inString) ?? 0);
    }
    if (c in simple) return simple[c];
    if (c === "\n" || (inString && c === " ")) return undefined;
    if ((c === "C" || c === "M" || c === "S" || c === "H" || c === "A") && text[i] === "-") {
      i++;
      const base = escapeOrChar(inString) ?? 0;
      if (c === "C") return control(base);
      return inString && c === "M" ? base | 0x80 : base;
    }
    if (c === "^") return control(escapeOrChar(inString) ?? 0);
    if (/[0-7]/.test(c)) {
      let n = c;
      while (n.length < 3 && /[0-7]/.test(text[i] ?? "")) n += text[i++];
      return parseInt(n, 8);
    }
    if (c === "x") {
      let n = "";
      while (/[0-9a-fA-F]/.test(text[i] ?? "")) n += text[i++];
      return parseInt(n || "0", 16);
    }
    if (c === "u" || c === "U") {
      const len = c === "u" ? 4 : 8;
      const n = text.slice(i, i + len);
      i += len;
      return parseInt(n, 16);
    }
    if (c === "N" && text[i] === "{") {
      const close = text.indexOf("}", i);
      const name = text.slice(i + 1, close);
      i = close + 1;
      return name.startsWith("U+") ? parseInt(name.slice(2), 16) : (e8.funcall("char-from-name", name) as number | null) ?? 0xfffd;
    }
    return c.codePointAt(0)!;
  };
  const escapeOrChar = (inString: boolean): number | undefined => {
    if (text[i] === "\\") {
      i++;
      return escape(inString);
    }
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    return cp;
  };
  const datum = (): Datum => {
    skip();
    const c = text[i];
    if (c === undefined) throw new Error("End of file during parsing");
    if (c === "(" || c === "[") {
      const close = c === "(" ? ")" : "]";
      i++;
      const items: Datum[] = [];
      for (;;) {
        skip();
        if (text[i] === close) {
          i++;
          return items;
        }
        if (i >= text.length) throw new Error("End of file during parsing");
        items.push(datum());
      }
    }
    if (c === ")" || c === "]") throw new Error("Invalid read syntax: )");
    if (c === "'" || c === "`") {
      i++;
      return [{ symbol: c === "'" ? "quote" : "`" }, datum()];
    }
    if (c === ",") {
      i += text[i + 1] === "@" ? 2 : 1;
      return [{ symbol: "," }, datum()];
    }
    if (c === "#" && text[i + 1] === "'") {
      i += 2;
      return [{ symbol: "function" }, datum()];
    }
    if (c === "?") {
      i++;
      return escapeOrChar(false) ?? 0;
    }
    if (c === '"') {
      i++;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++;
          const code = escape(true);
          if (code !== undefined) out += String.fromCodePoint(code & 0x3fffff);
        } else {
          const cp = text.codePointAt(i)!;
          out += String.fromCodePoint(cp);
          i += cp > 0xffff ? 2 : 1;
        }
      }
      if (i >= text.length) throw new Error("End of file during parsing");
      i++;
      return out;
    }
    let atom = "";
    let escaped = false;
    while (i < text.length && !/[\s()[\]'";`,]/.test(text[i]!)) {
      if (text[i] === "\\" && i + 1 < text.length) {
        escaped = true;
        atom += text[i + 1];
        i += 2;
      } else atom += text[i++];
    }
    return !escaped && /^[-+]?\d+\.?$/.test(atom) ? Number(atom.replace(/\.$/, "")) : { symbol: atom };
  };
  for (skip(); i < text.length; skip()) yield datum();
}

const symbolName = (d: Datum | undefined): string | undefined => (d !== undefined && typeof d === "object" && !Array.isArray(d) ? d.symbol : undefined);
/** A quoted datum's value, 'x as x. */
const unquote = (d: Datum | undefined): Datum | undefined => (Array.isArray(d) && symbolName(d[0]) === "quote" ? d[1] : d);
/** The value after a keyword in a plist. */
const plistGet = (items: Datum[], key: string): Datum | undefined => {
  const at = items.findIndex((d, k) => k >= 3 && symbolName(d) === key);
  return at >= 0 ? items[at + 1] : undefined;
};
const isNil = (d: Datum | undefined) => d === undefined || symbolName(d) === "nil" || (Array.isArray(d) && d.length === 0);

/**
 * Defines the abbrevs a file's define-abbrev-table forms give, as loading
 * it does, form by form, so those before a form E8 cannot read stay
 * defined: each abbrev (NAME EXPANSION HOOK :count N :case-fixed T), or
 * the older (NAME EXPANSION HOOK COUNT); system abbrevs are left out.
 */
function loadAbbrevs(text: string): void {
  for (const form of readLisp(text)) {
    if (!Array.isArray(form) || symbolName(form[0]) !== "define-abbrev-table") continue;
    const name = symbolName(unquote(form[1]));
    const abbrevs = unquote(form[2]);
    if (name === undefined) continue;
    table(name);
    for (const entry of Array.isArray(abbrevs) ? abbrevs : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const expansion = entry[1];
      if (typeof expansion !== "string") continue;
      if (!isNil(plistGet(entry, ":system"))) continue;
      const count = typeof entry[3] === "number" ? entry[3] : plistGet(entry, ":count");
      const hook = symbolName(unquote(entry[2]));
      defineAbbrev(name, entry[0], expansion, typeof count === "number" ? count : 0, {
        ...(hook !== undefined && hook !== "nil" ? { hook } : {}),
        ...(!isNil(plistGet(entry, ":case-fixed")) ? { caseFixed: true } : {}),
      });
    }
  }
}

/** Reads the abbrevs a file defines, as read-abbrev-file; the abbrevs are then unchanged. */
export function readAbbrevFile(file = abbrevFile(), quietly = false): void {
  if (!e8.fileReadableP(file)) e8.signal("file-missing", `Opening input file: No such file or directory, ${file}`, [file]);
  if (!quietly) e8.message(`Loading ${file}...`);
  loadAbbrevs(e8.readTextFile(file));
  if (!quietly) e8.message(`Loading ${file}...done`);
  e8.setDefault("abbrevs-changed", false);
}

/** A table as write-abbrev-file writes it, as insert-abbrev-table-description with READABLE nil. */
function tableForm(name: string): string {
  const entries = [...(tables.get(name) ?? new Map())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return `(define-abbrev-table '${name} '())\n\n`;
  return `(define-abbrev-table '${name}\n  '(\n${entries
    .map(([abbrev, { expansion, count, hook, caseFixed }]) => `    (${lispString(abbrev)} ${lispString(expansion)} ${hook ?? "nil"} :count ${count}${caseFixed ? " :case-fixed t" : ""})\n`)
    .join("")}   ))\n\n`;
}

/** Writes every table with abbrevs in it to a file, sorted by name, as write-abbrev-file. */
export function writeAbbrevFile(file = abbrevFile(), verbose = false): void {
  const names = [...tables.keys()].filter((n) => (tables.get(n)?.size ?? 0) > 0).sort();
  e8.writeTextFile(file, `;;-*-coding: utf-8;-*-\n${names.map(tableForm).join("")}`);
  if (verbose) e8.message(`Wrote ${file}`);
}

e8.defineCommand({
  name: "read-abbrev-file",
  doc: "Read abbrev definitions from file written with `write-abbrev-file'.\nOptional argument FILE is the name of the file to read;\nit defaults to the value of `abbrev-file-name'.",
  params: [{ name: "file", kind: "file", prompt: "Read abbrev file: " }],
  run: (file: string) => readAbbrevFile(file || abbrevFile()),
});
e8.defun("quietly-read-abbrev-file", (file?: string) => readAbbrevFile(file ?? abbrevFile(), true));

e8.defineCommand({
  name: "write-abbrev-file",
  doc: "Write all user-level abbrev definitions to a file of Lisp code.\nThe file written can be loaded in another session to define the same abbrevs.\nThe argument FILE is the file name to write.  If omitted or nil, it defaults\nto the value of `abbrev-file-name'.",
  params: [{ name: "file", kind: "file", prompt: "Write abbrev file: " }],
  run: (file: string) => writeAbbrevFile(file || abbrevFile(), true),
});

/**
 * Offers to save changed abbrevs, as abbrev--possibly-save does on
 * save-some-buffers-functions: asked whether to, unless save-abbrevs is
 * silently or `all`; with `query`, only whether there is anything to save.
 * True if it asked and was told no, which keeps save-some-buffers quiet.
 */
e8.defun("abbrev--possibly-save", (query?: e8.Value, all?: e8.Value) => {
  const save = e8.variable("save-abbrevs");
  const changed = e8.variable("abbrevs-changed");
  const on = (v: e8.Value | undefined) => v !== null && v !== undefined && v !== false;
  if (query === "query") return on(save) && on(changed);
  if (!on(save) || !on(changed)) return false;
  let declined = false;
  if (on(all) || save === "silently" || e8.yOrNP(`Save abbrevs in ${abbrevFile()}? `)) writeAbbrevFile();
  else declined = true;
  // Not asked again, whether saved or not.
  e8.setDefault("abbrevs-changed", false);
  return declined;
});
e8.setDefault("save-some-buffers-functions", [...((e8.defaultValue("save-some-buffers-functions") as e8.Value[] | undefined) ?? []), "abbrev--possibly-save"]);

// At startup the abbrev file is read if there is one, as Emacs's startup
// reads it after the init file, and the abbrevs then count as unchanged.
e8.addHook("emacs-startup-hook", () => {
  if (e8.variable("noninteractive") !== true && e8.fileReadableP(abbrevFile())) {
    e8.conditionCase(() => readAbbrevFile(abbrevFile(), true), { error: (e) => e8.message(e.message) });
  }
  e8.setDefault("abbrevs-changed", false);
});

for (const [keys, command] of [
  ["C-x a g", "add-global-abbrev"],
  ["C-x a l", "add-mode-abbrev"],
  ["C-x a +", "add-mode-abbrev"],
  ["C-x a C-a", "add-mode-abbrev"],
  ["C-x a i g", "inverse-add-global-abbrev"],
  ["C-x a i l", "inverse-add-mode-abbrev"],
  ["C-x a -", "inverse-add-global-abbrev"],
  ["C-x a e", "expand-abbrev"],
  ["C-x a '", "expand-abbrev"],
  ["C-x '", "expand-abbrev"],
] as const) {
  e8.bindKey(keys, command);
}

// Listing and editing the abbrevs, as list-abbrevs and edit-abbrevs: each
// table under its name, an abbrev a line with how often it was used and
// its expansion, which C-c C-c makes the abbrevs again.

/** A Lisp string, as prin1 writes one. */
const lispString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Spaces and tabs from `col` to `to`, as indent-to with indent-tabs-mode inserts them. */
function indentText(col: number, to: number): string {
  let out = "";
  let c = col;
  while (Math.floor(c / 8) * 8 + 8 <= to) {
    out += "\t";
    c = Math.floor(c / 8) * 8 + 8;
  }
  // indent-to puts at least nothing; a column already past gets no space.
  return out + " ".repeat(Math.max(0, to - c));
}

/** A table's description, as insert-abbrev-table-description writes it to read back. */
function tableDescription(name: string): string {
  const entries = [...(tables.get(name) ?? new Map())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let text = `(${name})\n\n`;
  for (const [abbrev, { expansion, count, hook }] of entries) {
    const quoted = lispString(abbrev);
    // Columns, not characters: indent-to may put a tab in.
    const countColumn = Math.max(quoted.length, 15) + String(count).length;
    let line = quoted + indentText(quoted.length, 15) + String(count) + indentText(countColumn, 20) + lispString(expansion);
    // The hook at column 45, as abbrev--describe puts it.
    if (hook !== undefined) line += indentText(Math.max(countColumn, 20) + lispString(expansion).length, 45) + hook;
    text += line + "\n";
  }
  return `${text}\n\n`;
}

/** The tables to list: the global one first, then the others. */
const tableNames = (): string[] => [GLOBAL, ...[...tables.keys()].filter((t) => t !== GLOBAL).sort()];

function prepareAbbrevList(): string {
  const buffer = "*Abbrevs*";
  e8.getBufferCreate(buffer);
  e8.withCurrentBuffer(buffer, () => {
    if (e8.variable("major-mode") !== "edit-abbrevs-mode") e8.call("edit-abbrevs-mode");
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.insert(tableNames().map(tableDescription).join(""));
    e8.gotoChar(e8.pointMin());
    e8.setBufferModified(false);
  });
  return buffer;
}

e8.defineCommand({
  name: "list-abbrevs",
  doc: "Show the abbrevs in *Abbrevs*: each table, and each abbrev in it with how often it was used and its expansion.",
  run: () => e8.call("display-buffer", prepareAbbrevList()),
});

e8.defineCommand({
  name: "edit-abbrevs",
  doc: "Edit the abbrevs in *Abbrevs*; C-c C-c makes them the abbrevs again.",
  run: () => e8.call("switch-to-buffer", prepareAbbrevList()),
});

e8.defineCommand({
  name: "edit-abbrevs-redefine",
  doc: "Redefine abbrevs according to current buffer contents.\nEvery abbrev not listed there goes, as define-abbrevs with ARG does.",
  run: () => {
    const text = e8.saveRestriction(() => {
      e8.widen();
      return e8.bufferText(e8.pointMin(), e8.pointMax());
    });
    const read = new Map<string, Map<string, Abbrev>>();
    let current: Map<string, Abbrev> | undefined;
    const unquoteLine = (q: string) => String(readLisp(q).next().value ?? "");
    for (const line of text.split("\n")) {
      const header = /^\(([^()\s]+)\)\s*$/.exec(line);
      if (header !== null) {
        current = new Map();
        read.set(header[1]!, current);
        continue;
      }
      const entry = /^("(?:[^"\\]|\\.)*")\s+(\d+)\s+("(?:[^"\\]|\\.)*")(?:\s+(\S+))?/.exec(line);
      if (entry !== null && current !== undefined) {
        const hook = entry[4] === undefined || entry[4] === "nil" ? undefined : entry[4];
        current.set(unquoteLine(entry[1]!), { expansion: unquoteLine(entry[3]!), count: Number(entry[2]), ...(hook ? { hook } : {}) });
      }
    }
    // Every abbrev goes first, as kill-all-abbrevs, so the abbrevs are changed.
    tables.clear();
    for (const [name, entries] of read) tables.set(name, entries);
    e8.setDefault("abbrevs-changed", true);
    e8.setBufferModified(false);
  },
});

/** Redefines the abbrevs from *Abbrevs* and writes them to a file, as abbrev-edit-save-to-file. */
function editSaveToFile(file: string): void {
  e8.call("edit-abbrevs-redefine");
  writeAbbrevFile(file, true);
}

e8.defineCommand({
  name: "abbrev-edit-save-to-file",
  doc: "Save to FILE all the user-level abbrev definitions in current buffer.",
  params: [{ name: "file", kind: "file", prompt: "Save abbrevs to file: " }],
  run: (file: string) => editSaveToFile(file || abbrevFile()),
});

e8.defineCommand({
  name: "abbrev-edit-save-buffer",
  doc: "Save all the user-level abbrev definitions in current buffer.\nThe saved abbrevs are written to the file specified by\n`abbrev-file-name'.",
  run: () => {
    editSaveToFile(abbrevFile());
    e8.setDefault("abbrevs-changed", false);
  },
});

e8.defineMajorMode({
  name: "edit-abbrevs-mode",
  modeName: "Edit-Abbrevs",
  doc: "The mode of *Abbrevs*: edit the abbrevs listed, then C-c C-c to make them the abbrevs, or C-x C-s to save them to the abbrev file too.",
  bindings: { "C-c C-c": "edit-abbrevs-redefine", "C-x C-s": "abbrev-edit-save-buffer", "C-x C-w": "abbrev-edit-save-to-file" } as unknown as Record<string, e8.CommandName>,
});
