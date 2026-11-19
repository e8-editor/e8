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

/** The abbrev tables, by name, each abbrev's name in lower case to its expansion and how often it was used. */
const tables = new Map<string, Map<string, { expansion: string; count: number }>>();

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
 * Defines an abbrev, as define-abbrev: an empty expansion undefines it.
 * A change marks the abbrevs changed, for saving them.
 */
export function defineAbbrev(tableName: string, name: string, expansion: string, count = 0): void {
  const key = name.toLowerCase();
  const old = tables.get(tableName)?.get(key);
  if ((old?.expansion ?? "") !== expansion) e8.setDefault("abbrevs-changed", true);
  if (expansion === "") table(tableName).delete(key);
  else table(tableName).set(key, { expansion, count });
}

/** What an abbrev expands into in a table, matching case loosely, as abbrev-expansion. */
const abbrevExpansion = (name: string, tableName: string): string | undefined => tables.get(tableName)?.get(name.toLowerCase())?.expansion;

/**
 * The tables to look abbrevs up in: the mode's, then the tables of the
 * modes it is built on, which define-derived-mode makes its parents, then
 * the global one, as abbrev--active-tables and abbrev-symbol go through them.
 */
const activeTables = (): string[] => [...e8.derivedModeAllParents().map((mode) => `${mode}-abbrev-table`), GLOBAL];

/** The word before point and the abbrev it names, if any, as abbrev--before-point. */
function abbrevBeforePoint(): { table: string; name: string; start: number; end: number } | undefined {
  const pos = e8.point();
  return e8.saveExcursion(() => {
    e8.call("backward-word");
    const start = e8.point();
    e8.call("forward-word");
    const end = Math.min(e8.point(), pos);
    if (end <= start) return undefined;
    const name = e8.bufferSubstringNoProperties(start, end);
    for (const t of activeTables()) {
      if (abbrevExpansion(name, t) !== undefined) return { table: t, name, start, end };
    }
    return undefined;
  });
}

/** Puts an abbrev's expansion in place of the word, with the case the word had, as abbrev-insert. */
function abbrevInsert(t: string, name: string, start: number, wordEnd: number): void {
  const entry = tables.get(t)!.get(name.toLowerCase())!;
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
}

/** Expands the abbrev before point, if there is one, as expand-abbrev; returns whether it did. */
function expandAbbrev(): boolean {
  const found = abbrevBeforePoint();
  if (found === undefined) return false;
  const pos = e8.point();
  const after = pos - found.end;
  abbrevInsert(found.table, found.name, found.start, found.end);
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
    defineAbbrev(tableName, name, exp ?? "");
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
    defineAbbrev(tableName, name, exp);
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
  run: (abbrev: string, expansion: string) => defineAbbrev(GLOBAL, abbrev, expansion),
});
e8.defineCommand({
  name: "define-mode-abbrev",
  doc: "Define an abbrev for the major mode, asking for its name and expansion.",
  params: [
    { name: "abbrev", kind: "string", prompt: "Define mode abbrev: " },
    { name: "expansion", kind: "string", prompt: "Expansion: " },
  ],
  run: (abbrev: string, expansion: string) => defineAbbrev(localTable(), abbrev, expansion),
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

/** The file abbrevs are read from and saved to, as abbrev-file-name. */
const abbrevFile = (): string => {
  const named = e8.variable("abbrev-file-name");
  return typeof named === "string" && named !== "" ? named : e8.expandFileName("abbrev_defs", String(e8.variable("user-emacs-directory") ?? "~/.config/e8/"));
};

/** A Lisp datum as the reader gives it: a string, a number, a symbol's name, or a list. */
type Datum = string | number | { symbol: string } | Datum[];

/** Reads the Lisp data in `text`, as `read` would, for the forms abbrev files have. */
function readLisp(text: string): Datum[] {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== ";") return;
      while (i < text.length && text[i] !== "\n") i++;
    }
  };
  const datum = (): Datum => {
    skip();
    const c = text[i];
    if (c === undefined) throw new Error("End of file during parsing");
    if (c === "(") {
      i++;
      const items: Datum[] = [];
      for (;;) {
        skip();
        if (text[i] === ")") {
          i++;
          return items;
        }
        if (i >= text.length) throw new Error("End of file during parsing");
        items.push(datum());
      }
    }
    if (c === "'") {
      i++;
      return [{ symbol: "quote" }, datum()];
    }
    if (c === '"') {
      i++;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          const n = text[++i];
          const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", e: "\x1b", a: "\x07", f: "\f", "\n": "" };
          out += n !== undefined && n in escapes ? escapes[n]! : (n ?? "");
          i++;
        } else out += text[i++];
      }
      i++;
      return out;
    }
    const start = i;
    while (i < text.length && !/[\s()'";]/.test(text[i]!)) i++;
    const atom = text.slice(start, i);
    return /^[-+]?\d+$/.test(atom) ? Number(atom) : { symbol: atom.replace(/\\(.)/g, "$1") };
  };
  const out: Datum[] = [];
  for (skip(); i < text.length; skip()) out.push(datum());
  return out;
}

const symbolName = (d: Datum | undefined): string | undefined => (d !== undefined && typeof d === "object" && !Array.isArray(d) ? d.symbol : undefined);
/** A quoted datum's value, 'x as x. */
const unquote = (d: Datum | undefined): Datum | undefined => (Array.isArray(d) && symbolName(d[0]) === "quote" ? d[1] : d);

/**
 * Defines the abbrevs a file's define-abbrev-table forms give, as loading
 * it does: each abbrev (NAME EXPANSION HOOK :count N), or the older
 * (NAME EXPANSION HOOK COUNT).
 */
function loadAbbrevs(text: string): void {
  for (const form of readLisp(text)) {
    if (!Array.isArray(form) || symbolName(form[0]) !== "define-abbrev-table") continue;
    const name = symbolName(unquote(form[1]));
    const abbrevs = unquote(form[2]);
    if (name === undefined) continue;
    table(name);
    for (const entry of Array.isArray(abbrevs) ? abbrevs : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
      const at = entry.findIndex((d) => symbolName(d) === ":count");
      const count = at >= 0 ? entry[at + 1] : entry[3];
      if (entry.some((d, k) => symbolName(d) === ":system" && entry[k + 1] !== undefined && symbolName(entry[k + 1]) !== "nil")) continue;
      defineAbbrev(name, entry[0], entry[1], typeof count === "number" ? count : 0);
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
  return `(define-abbrev-table '${name}\n  '(\n${entries.map(([abbrev, { expansion, count }]) => `    (${lispString(abbrev)} ${lispString(expansion)} nil :count ${count})\n`).join("")}   ))\n\n`;
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
  for (const [abbrev, { expansion, count }] of entries) {
    const quoted = lispString(abbrev);
    // Columns, not characters: indent-to may put a tab in.
    const countColumn = Math.max(quoted.length, 15) + String(count).length;
    text += quoted + indentText(quoted.length, 15) + String(count) + indentText(countColumn, 20) + lispString(expansion) + "\n";
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
  doc: "Make the abbrevs the ones *Abbrevs* lists now, as edit-abbrevs left them.",
  run: () => {
    const text = e8.bufferText(e8.pointMin(), e8.pointMax());
    const read = new Map<string, Map<string, { expansion: string; count: number }>>();
    let current: Map<string, { expansion: string; count: number }> | undefined;
    const unquote = (s: string) => s.slice(1, -1).replace(/\\(.)/g, "$1");
    for (const line of text.split("\n")) {
      const header = /^\(([^()\s]+)\)\s*$/.exec(line);
      if (header !== null) {
        current = new Map();
        read.set(header[1]!, current);
        continue;
      }
      const entry = /^("(?:[^"\\]|\\.)*")\s+(\d+)\s+("(?:[^"\\]|\\.)*")/.exec(line);
      if (entry !== null && current !== undefined) current.set(unquote(entry[1]!).toLowerCase(), { expansion: unquote(entry[3]!), count: Number(entry[2]) });
    }
    for (const [name, entries] of read) tables.set(name, entries);
    e8.setBufferModified(false);
  },
});

e8.defineMajorMode({
  name: "edit-abbrevs-mode",
  modeName: "Edit-Abbrevs",
  doc: "The mode of *Abbrevs*: edit the abbrevs listed, then C-c C-c to make them the abbrevs.",
  bindings: { "C-c C-c": "edit-abbrevs-redefine", "C-x C-s": "edit-abbrevs-redefine" } as Record<string, e8.CommandName>,
});
