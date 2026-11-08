// Transient menus, after transient.el 0.10: a prefix command shows its
// suffixes in a window below, grouped in columns, and the keys it shows run
// them. Suffixes run and leave the menu, or run and stay; infix arguments,
// switches (-a, --all) and options (--author=), are set in the menu and read
// by the suffix with transientArgs; a prefix's suffix can be another prefix,
// to which C-g goes back. C-g quits one menu and C-q all of them.
//
// A prefix is defined with transientDefinePrefix and its layout as groups:
//
//   transientDefinePrefix("my-menu", { doc: "...", groups: [
//     { description: "File", items: [["o", "Open", "find-file"], ["-a", "All", "--all"]] },
//   ] });
//
// A group whose items are groups shows them side by side, as Lisp's nested
// vectors do; class "row" puts a group's suffixes on one line. A suffix is
// [key, description, command or argument, options], or the name of a suffix
// defined with transientDefineSuffix, which carries its own key and
// description.
//
// As transient.el does: suffixes and groups have levels, and a prefix shows
// those at or under its level (transient-default-level, 4); C-x l changes
// a prefix's or a suffix's level, kept in transient-levels-file. C-x s sets
// a prefix's arguments for the session and C-x C-s saves them in
// transient-values-file, C-x C-k resets them; C-x p and C-x n go through
// the arguments used before. C-h then a key describes that suffix, C-h C-h
// the prefix. Arguments a prefix says are incompatible turn each other
// off. C-x t shows the common commands. A menu taller than the frame is
// cut to fit; with transient-show-popup nil it does not show until C-h.

import { truthy } from "subr";

e8.defineFace({ name: "transient-heading", doc: "Face used for headings.", attributes: { inherit: "font-lock-keyword-face" } });
e8.defineFace({ name: "transient-key", doc: "Face used for keys.", attributes: { inherit: "font-lock-builtin-face" } });
e8.defineFace({ name: "transient-argument", doc: "Face used for enabled arguments.", attributes: { inherit: "font-lock-string-face", weight: "bold" } });
e8.defineFace({ name: "transient-inactive-argument", doc: "Face used for inactive arguments.", attributes: { inherit: "shadow" } });
e8.defineFace({ name: "transient-inapt-argument", doc: "Face used for enabled arguments of an inapt suffix.", attributes: { inherit: "shadow", weight: "bold" } });
e8.defineFace({ name: "transient-value", doc: "Face used for values.", attributes: { inherit: "font-lock-string-face", weight: "bold" } });
e8.defineFace({ name: "transient-inactive-value", doc: "Face used for inactive values.", attributes: { inherit: "shadow" } });
e8.defineFace({ name: "transient-unreachable", doc: "Face used for suffixes unreachable from the current prefix sequence.", attributes: { inherit: "shadow" } });
e8.defineFace({ name: "transient-inapt-suffix", doc: "Face used for suffixes that are inapt at this time.", attributes: { inherit: "shadow", slant: "italic" } });
e8.defineFace({ name: "transient-active-infix", doc: "Face used for the infix for which the value is being read.", attributes: { inherit: "highlight" } });
e8.defineFace({ name: "transient-delimiter", doc: "Face used for delimiters and separators.", attributes: { inherit: "shadow" } });
e8.defineFace({ name: "transient-unreachable-key", doc: "Face used for keys unreachable from the current prefix sequence.", attributes: { inherit: "shadow", weight: "normal" } });
const keyFaces: [string, string, string, string][] = [
  ["transient-key-stay", "Face used for keys of suffixes that don't exit the menu.", "#22aa22", "#ddffdd"],
  ["transient-key-noop", "Face used for keys of suffixes that currently cannot be invoked.", "grey80", "grey30"],
  ["transient-key-return", "Face used for keys of suffixes that return to the parent menu.", "#aaaa11", "#ffffcc"],
  ["transient-key-recurse", "Face used for keys of sub-menus whose suffixes return to the current menu.", "#2266ff", "#2299ff"],
  ["transient-key-stack", "Face used for keys of sub-menus that exit the current menu.", "#dd4488", "#ff6699"],
  ["transient-key-exit", "Face used for keys of suffixes that exit the menu.", "#aa2222", "#ffdddd"],
];
for (const [name, doc, light, dark] of keyFaces) {
  e8.defineFace({ name, doc, attributes: { inherit: "transient-key" }, light: { foreground: light }, dark: { foreground: dark } });
}

e8.defineVariable({
  name: "transient-semantic-coloring",
  doc: "Whether keys are coloured by what their suffixes do: stay in the menu, exit it, or go into another.",
  value: true,
});
e8.defineVariable({ name: "transient-force-single-column", doc: "Whether to show the suffixes in one column, rather than side by side.", value: false });
e8.defineVariable({ name: "transient-current-command", doc: "The transient prefix command from which the running suffix was invoked.", value: null });
e8.defineVariable({ name: "transient-current-prefix", doc: "The name of the prefix whose menu is showing, or from which the running suffix was invoked.", value: null });
e8.defineVariable({ name: "transient-default-level", doc: "The level of a prefix whose level was not changed: suffixes and groups of higher levels do not show.", value: 4 });
e8.defineVariable({ name: "transient-show-popup", doc: "Whether to show the menu's window at once: t, or nil to show it only on C-h.", value: true });
e8.defineVariable({ name: "transient-show-common-commands", doc: "Whether to show the common commands, C-x s, C-x l and the rest, below each menu.", value: false });
e8.defineVariable({ name: "transient-levels-file", doc: "The file in which the levels of prefixes and suffixes are kept; transient/levels.json in user-emacs-directory when nil.", value: null });
e8.defineVariable({ name: "transient-values-file", doc: "The file in which the saved values of prefixes are kept; transient/values.json in user-emacs-directory when nil.", value: null });
e8.defineVariable({ name: "transient-history-limit", doc: "How many earlier values of each prefix to keep.", value: 10 });

/** Text, its faces with it. */
type Text = string | e8.PropertizedString;
/** A description: text, or a function giving it, called in the buffer the menu was invoked from. */
export type Description = Text | (() => Text | undefined);
type Command = string;
type Predicate = () => unknown;

/** What a suffix can say beside its key, description and command or argument, as transient's slots. */
export interface SuffixOptions {
  description?: Description;
  /**
   * Whether running it leaves the menu: true stays, false exits; for a
   * prefix, true returns to this menu after it. Or one of transient's
   * behaviours by name: "call" or "stay" stays, "exit" exits, "return"
   * goes back to the menu before, "recurse" enters a sub-menu that comes
   * back here.
   */
  transient?: boolean | "call" | "stay" | "exit" | "return" | "recurse";
  if?: Predicate;
  ifNot?: Predicate;
  ifMode?: string | string[];
  ifNotMode?: string | string[];
  ifDerived?: string | string[];
  ifNotDerived?: string | string[];
  ifNil?: string;
  ifNonNil?: string;
  inaptIf?: Predicate;
  inaptIfNot?: Predicate;
  /** For an option, the values to choose from. */
  choices?: string[];
  /** For an option, what reads its value, called with the prompt and the value now. */
  reader?: (prompt: string, initial: string | undefined) => string;
  prompt?: string;
  /** What it is, if not worked out: "switch", "option", "suffix", "information". */
  class?: "switch" | "option" | "switches" | "suffix" | "information";
  /** For switches, how the argument is made from a choice, %s for it: "--%s-order". */
  argumentFormat?: string;
  /** Shows the description only, as :info. */
  info?: Description;
  format?: string;
  face?: string;
  level?: number;
  key?: string;
  /** For an option, whether it takes several values, comma-separated when read: "repeat" puts the argument before each, "rest" once before them all. */
  multiValue?: "repeat" | "rest";
  /** For an option, whether pressing it while set reads a new value rather than unsetting it. */
  alwaysRead?: boolean;
  /** For an option, whether an empty answer sets it to empty rather than unsetting it. */
  allowEmpty?: boolean;
  /** Its documentation, as C-h shows it. */
  doc?: string;
}

/** A suffix in a layout: [key, description, command or argument, options], or a suffix defined by name. */
export type SuffixSpec = [string, Description, Command | DefinedFunction, SuffixOptions?] | [string, SuffixOptions & { info: Description }] | string;
type DefinedFunction = (() => unknown) & { readonly name?: string };

export interface Group {
  description?: Description;
  class?: "column" | "row" | "columns" | "subgroups";
  /** Pads each key to the widest of the group's keys, or to this many columns. */
  padKeys?: boolean | number;
  hide?: Predicate;
  if?: Predicate;
  ifNot?: Predicate;
  /** Its level: the group shows only in a prefix of that level or higher. */
  level?: number;
  items: (SuffixSpec | Group | null)[];
}

export interface PrefixDefinition {
  doc?: string;
  /** The value the infix arguments start with: arguments, or a function or variable that gives them. */
  value?: string[] | (() => string[]) | string;
  /** Whether suffixes stay in the menu unless they say otherwise. */
  transientSuffix?: boolean;
  /** Whether keys that are no suffix's run their commands and stay, rather than being refused. */
  transientNonSuffix?: boolean;
  /** Arguments that cannot be used together, each list of them: setting one unsets the others, as :incompatible. */
  incompatible?: string[][];
  /** The man page C-h C-h shows, as :man-page. */
  manPage?: string;
  groups: Group[];
}

/** A suffix as the menu has it once it is set up, as transient's suffix objects. */
interface Suffix {
  key: string;
  description?: Description;
  command: string;
  kind: "suffix" | "prefix" | "infix" | "information";
  argument?: string;
  infixClass?: "switch" | "option" | "switches";
  options: SuffixOptions;
  /** For an infix: its value, true for a switch that is on, the string for an option. */
  value?: string | boolean;
  inapt?: boolean;
  /** Its level: it shows only if the prefix's level is as high. */
  level: number;
}

interface Layout {
  group: Group;
  children: (Layout | Suffix | string)[];
}

/** Each prefix's definition, by name. */
const prefixes = new Map<string, PrefixDefinition>();
/** Each suffix defined by name, with its own key and description. */
const definedSuffixes = new Map<string, SuffixOptions & { key?: string; description?: Description }>();

// The menu showing: its prefix, its suffixes and values, and the menus it was entered from.
interface Active {
  prefix: string;
  layout: Layout[];
  suffixes: Suffix[];
  buffer: e8.Buffer;
  window: number;
}
let active: Active | undefined;
/** The menus a sub-menu was entered from, to go back to: their prefix and infix values. */
const stack: { prefix: string; values: Map<string, string | boolean | undefined>; returnHere: boolean }[] = [];
/** The values infixes had when the menu last showed, kept across a suffix that stays. */
let values = new Map<string, string | boolean | undefined>();

// Levels, values and history, as transient-levels, transient-values and transient-history.

/** Where transient keeps FILE: VARIABLE's file, or transient/FILE in user-emacs-directory. */
function stateFile(variable: string, file: string): string {
  const set = e8.variable(variable);
  if (typeof set === "string") return e8.expandFileName(set);
  const dir = String(e8.variable("user-emacs-directory") ?? "~/.config/e8/");
  return e8.expandFileName(`transient/${file}`, dir);
}
function readState<T>(variable: string, file: string): T | undefined {
  try {
    const f = stateFile(variable, file);
    return e8.fileExistsP(f) ? (JSON.parse(e8.readTextFile(f)) as T) : undefined;
  } catch {
    return undefined;
  }
}
function writeState(variable: string, file: string, value: unknown): void {
  const f = stateFile(variable, file);
  e8.makeDirectory(e8.fileNameDirectory(f) ?? ".", { parents: true });
  e8.writeTextFile(f, `${JSON.stringify(value, null, 1)}\n`);
}

/** Each prefix's level, and its suffixes' levels by command, as transient-levels. */
let levels: { [prefix: string]: { level?: number; suffixes?: { [command: string]: number } } } | undefined;
const getLevels = () => (levels ??= readState("transient-levels-file", "levels.json") ?? {});
/** The level of PREFIX: what C-x l set, or transient-default-level. */
export function transientPrefixLevel(prefix: string): number {
  return getLevels()[prefix]?.level ?? Number(e8.variable("transient-default-level") ?? 4);
}
/** The level of a suffix of PREFIX: what C-x l set, or its own, or 1. */
function suffixLevel(prefix: string, command: string, own: number | undefined): number {
  return getLevels()[prefix]?.suffixes?.[command] ?? own ?? 1;
}

/** Each prefix's value set for the session, and saved, as transient-values. */
const setValues = new Map<string, string[]>();
let savedValues: { [prefix: string]: string[] } | undefined;
const getSaved = () => (savedValues ??= readState("transient-values-file", "values.json") ?? {});
/** Each prefix's earlier values, the latest first, as transient-history. */
const history = new Map<string, string[][]>();
let historyAt = -1;

const BUFFER = " *transient*";
const MAP = "transient--map";
e8.defineKeymap(MAP);

// Setting a menu up.

function oneOf(mode: string | string[] | undefined): boolean {
  const modes = mode === undefined ? [] : Array.isArray(mode) ? mode : [mode];
  return modes.includes(String(e8.variable("major-mode")));
}

/** Whether a suffix or group shows, as transient--do-suffix-p. */
function shows(o: SuffixOptions | Group): boolean {
  const s = o as SuffixOptions;
  if (s.if) return truthy(s.if() as e8.Value);
  if (s.ifNot) return !truthy(s.ifNot() as e8.Value);
  if (s.ifNonNil) return truthy(e8.variable(s.ifNonNil));
  if (s.ifNil) return !truthy(e8.variable(s.ifNil));
  if (s.ifMode !== undefined) return oneOf(s.ifMode);
  if (s.ifNotMode !== undefined) return !oneOf(s.ifNotMode);
  if (s.ifDerived !== undefined) return e8.derivedModeP(...[s.ifDerived].flat());
  if (s.ifNotDerived !== undefined) return !e8.derivedModeP(...[s.ifNotDerived].flat());
  return true;
}

function inapt(o: SuffixOptions): boolean {
  if (o.inaptIf) return truthy(o.inaptIf() as e8.Value);
  if (o.inaptIfNot) return !truthy(o.inaptIfNot() as e8.Value);
  return false;
}

/** The name of a command given as a function, defined once as transient does with a transient:PREFIX:KEY symbol. */
function commandName(prefix: string, key: string, command: Command | DefinedFunction): string {
  if (typeof command === "string") return command;
  const name = `transient:${prefix}:${key.replace(/ /g, "")}`;
  if (!e8.fboundp(name)) e8.defineCommand({ name, doc: "A suffix of a transient menu.", run: () => void command() });
  return name;
}

/** A suffix of PREFIX from its spec, as transient--parse-suffix and transient--init-suffix make it. */
function makeSuffix(prefix: string, spec: SuffixSpec): Suffix | undefined {
  let key: string;
  let description: Description | undefined;
  let target: Command | DefinedFunction | undefined;
  let options: SuffixOptions;
  if (typeof spec === "string") {
    const defined = definedSuffixes.get(spec);
    if (!defined) return { key: "", command: spec, kind: prefixes.has(spec) ? "prefix" : "suffix", options: {}, level: 1 };
    ({ key = "", description } = defined);
    target = spec;
    options = defined;
  } else if (spec.length === 2) {
    [key, options] = spec;
    description = options.info;
    return { key, description, command: "", kind: "information", options, level: options.level ?? 1 };
  } else {
    [key, description, target, options = {}] = spec;
  }
  if (options.description !== undefined) description = options.description;
  if (!shows(options)) return undefined;
  const level = suffixLevel(prefix, typeof target === "string" ? target : key, options.level);
  if (!editingLevels && (level === 0 || level > transientPrefixLevel(prefix))) return undefined;
  const isArgument =
    typeof target === "string" && (/^-/.test(target) || options.class === "switch" || options.class === "option" || options.class === "switches") && options.class !== "suffix";
  const suffix: Suffix = isArgument
    ? {
        key,
        description,
        command: `transient:${prefix}:${target}`,
        kind: "infix",
        argument: target as string,
        infixClass:
          options.class === "switch" || options.class === "option" || options.class === "switches"
            ? options.class
            : (target as string).endsWith("=") || options.choices || options.reader
              ? "option"
              : "switch",
        options,
        level,
      }
    : { key, description, command: commandName(prefix, key, target!), kind: prefixes.has(target as string) ? "prefix" : "suffix", options, level };
  suffix.inapt = inapt(options);
  return suffix;
}

/** The layout of a group, its children set up, as transient--init-child. */
function makeLayout(prefix: string, group: Group): Layout | undefined {
  if (!shows(group)) return undefined;
  if (!editingLevels && (group.level ?? 1) > transientPrefixLevel(prefix)) return undefined;
  const children: (Layout | Suffix | string)[] = [];
  for (const item of group.items) {
    if (item === null) continue;
    if (typeof item === "object" && !Array.isArray(item)) {
      const sub = makeLayout(prefix, item);
      if (sub) children.push(sub);
    } else if (typeof item === "string" && !definedSuffixes.has(item) && !prefixes.has(item)) {
      // Text, as a string in a Lisp group is: "" leaves a cell blank.
      children.push(item);
    } else {
      const suffix = makeSuffix(prefix, item);
      if (suffix) children.push(suffix);
    }
  }
  return { group, children };
}

function classOf(layout: Layout): NonNullable<Group["class"]> {
  return layout.group.class ?? (layout.group.items.some((i) => i !== null && typeof i === "object" && !Array.isArray(i)) ? "columns" : "column");
}

function flatten(layouts: Layout[]): Suffix[] {
  return layouts.flatMap((l) => l.children.flatMap((c) => (typeof c === "string" ? [] : "group" in c ? flatten([c]) : [c])));
}

/** The value a prefix starts with, as its :value says. */
function initialValue(prefix: string): string[] {
  const set = setValues.get(prefix) ?? getSaved()[prefix];
  if (set) return [...set];
  return defaultValue(prefix);
}

/** The value a prefix's definition gives it, as its :value. */
function defaultValue(prefix: string): string[] {
  const value = prefixes.get(prefix)?.value;
  if (value === undefined) return [];
  if (typeof value === "function") return value();
  if (typeof value === "string") {
    const v = e8.variable(value);
    return Array.isArray(v) ? v.map(String) : [];
  }
  return value;
}

/** Gives each infix its value from VALUE, a list of arguments, as transient-init-value does. */
function initValues(suffixes: Suffix[], value: string[]): Map<string, string | boolean | undefined> {
  const map = new Map<string, string | boolean | undefined>();
  for (const s of suffixes) {
    if (s.kind !== "infix") continue;
    const arg = s.argument!;
    if (s.infixClass === "switch") {
      map.set(s.command, value.includes(arg) ? true : undefined);
    } else if (s.infixClass === "switches") {
      const format = s.options.argumentFormat ?? `${arg}%s`;
      map.set(s.command, value.find((a) => (s.options.choices ?? []).some((c) => format.replace("%s", c) === a)));
    } else if (s.options.multiValue === "repeat") {
      const found = value.filter((a) => a.startsWith(arg)).map((a) => a.slice(arg.length));
      map.set(s.command, found.length > 0 ? found.join(",") : undefined);
    } else {
      const found = value.find((a) => a.startsWith(arg));
      map.set(s.command, found === undefined ? undefined : found.slice(arg.length));
    }
  }
  return map;
}

// Drawing.

/** A suffix's key as the menu shows it, padded and in the face for what it does. */
function formatKey(s: Suffix, pad: number | undefined): Text {
  let key = s.key;
  if (pad !== undefined) key = key.padEnd(pad);
  return face(key, keyFace(s));
}

function keyFace(s: Suffix): string {
  if (!truthy(e8.variable("transient-semantic-coloring"))) return s.command ? "transient-key" : "transient-key-noop";
  const kind = behaviour(s);
  return kind === "stay" || kind === "infix" ? "transient-key-stay" : kind === "stack" ? "transient-key-stack" : kind === "recurse" ? "transient-key-recurse" : kind === "return" ? "transient-key-return" : "transient-key-exit";
}

/** What running a suffix does, as transient--make-predicate-map works it out. */
function behaviour(s: Suffix): "exit" | "stay" | "stack" | "recurse" | "infix" | "return" {
  if (s.kind === "infix") return "infix";
  const named = s.options.transient;
  if (named === "call" || named === "stay") return "stay";
  if (named === "exit") return "exit";
  if (named === "return") return "return";
  if (named === "recurse") return s.kind === "prefix" ? "recurse" : "stay";
  const transient = s.options.transient ?? (s.kind === "suffix" ? prefixes.get(active?.prefix ?? "")?.transientSuffix : undefined);
  if (s.kind === "prefix") return transient === true ? "recurse" : "stack";
  return transient ? "stay" : "exit";
}

function describe(d: Description | undefined): Text | undefined {
  if (typeof d === "function") return active ? e8.withCurrentBuffer(active.buffer, d) : d();
  return d;
}

/** A suffix's value as the menu shows it, as transient-format-value. */
function formatValue(s: Suffix): Text {
  const value = values.get(s.command);
  if (s.infixClass === "switch") return face(s.argument!, value ? (s.inapt ? "transient-inapt-argument" : "transient-argument") : "transient-inactive-argument");
  if (s.infixClass === "switches") {
    // --[topo|author-date|date]-order, the chosen one lit, as transient-switches show.
    const format = s.options.argumentFormat ?? `${s.argument}%s`;
    const [before, after] = format.split("%s");
    const choices = (s.options.choices ?? []).flatMap((c, i) => [...(i > 0 ? [face("|", "transient-delimiter")] : []), face(c, format.replace("%s", c) === value ? "transient-value" : "transient-inactive-value")]);
    const f = value ? "transient-argument" : "transient-inactive-argument";
    return e8.concat(face(before, f), face("[", "transient-delimiter"), ...choices, face("]", "transient-delimiter"), face(after ?? "", f));
  }
  if (value === undefined) return face(s.argument!, "transient-inactive-argument");
  return e8.concat(face(s.argument!, s.inapt ? "transient-inapt-argument" : "transient-argument"), face(String(value), s.inapt ? "transient-inapt-argument" : "transient-value"));
}

/** TEXT in face F; text that has faces of its own keeps them, as transient-format-description leaves a description's faces. */
const face = (text: Text, f: string): Text => (typeof text === "string" ? e8.propertize(text, { face: f }) : text);
const width = (text: Text): number => [...String(text)].length;

/** A suffix as a line of the menu, as transient-format. */
function formatSuffix(s: Suffix, pad: number | undefined): Text {
  const format = s.options.format ?? (s.kind === "infix" ? " %k %d (%v)" : s.kind === "information" ? " %k %d" : " %k %d");
  let desc = describe(s.description);
  desc = desc === undefined ? face("(BUG: no description)", "error") : s.options.face ? face(desc, s.options.face) : desc;
  if (s.inapt) desc = face(desc, "transient-inapt-suffix");
  const key = s.kind === "information" ? (s.key || " ") : formatKey(s, pad);
  if (editingLevels && s.kind !== "information") {
    const shown = s.level !== 0 && s.level <= transientPrefixLevel(active?.prefix ?? "");
    desc = e8.concat(face(`${s.level} `, shown ? "transient-value" : "transient-inactive-value"), shown ? desc! : face(desc!, "transient-inactive-argument"));
  }
  const parts = format.split(/(%[kdv%])/).map((p) => (p === "%k" ? key : p === "%d" ? desc! : p === "%v" ? formatValue(s) : p === "%%" ? "%" : p));
  return e8.concat(...parts);
}

/** How wide a group's keys are padded, as transient--maybe-pad-keys. */
function padOf(layout: Layout, parent?: Layout): number | undefined {
  const pad = layout.group.padKeys ?? parent?.group.padKeys;
  if (!pad) return undefined;
  const widths = layout.children.filter((c): c is Suffix => typeof c !== "string" && !("group" in c)).map((s) => [...s.key].length);
  return Math.max(typeof pad === "number" ? pad : 0, ...widths);
}

function groupDescription(layout: Layout): Text | undefined {
  const desc = describe(layout.group.description);
  return desc === undefined ? undefined : face(desc, "transient-heading");
}

/** The text of a group's lines, as transient--insert-group. */
function insertGroup(layout: Layout, parent?: Layout): void {
  const desc = groupDescription(layout);
  if (desc !== undefined) {
    e8.insert(desc);
    e8.insert("\n");
  }
  const kind = truthy(e8.variable("transient-force-single-column")) && classOf(layout) === "columns" ? "single" : classOf(layout);
  const suffixes = (l: Layout) => l.children.filter((c): c is Suffix | string => typeof c === "string" || !("group" in c));
  const cell = (c: Suffix | string, pad: number | undefined) => (typeof c === "string" ? face(c, "transient-heading") : formatSuffix(c, pad));
  if (kind === "row") {
    const pad = padOf(layout, parent);
    for (const s of suffixes(layout)) {
      e8.insert(cell(s, pad));
      e8.insert("   ");
    }
    e8.insert("\n");
  } else if (kind === "column") {
    const pad = padOf(layout, parent);
    for (const s of suffixes(layout)) {
      const str = cell(s, pad);
      if (String(str) === "") continue;
      e8.insert(str);
      if (!/.\n$/.test(String(str))) e8.insert("\n");
    }
  } else if (kind === "single") {
    for (const c of layout.children) if (typeof c !== "string" && "group" in c) insertGroup(c, layout);
  } else if (kind === "columns") {
    const columns = layout.children
      .filter((c): c is Layout => typeof c !== "string" && "group" in c)
      .map((column) => {
        const pad = padOf(column, layout);
        const head = groupDescription(column);
        return [...(head !== undefined ? [head] : []), ...suffixes(column).map((s) => cell(s, pad))];
      });
    // Each column starts two past the widest cell of the one before.
    const stops: number[] = [0];
    for (const column of columns.slice(0, -1)) stops.push(stops[stops.length - 1] + 2 + Math.max(0, ...column.map(width)));
    const rows = Math.max(0, ...columns.map((c) => c.length));
    for (let row = 0; row < rows; row++) {
      columns.forEach((column, i) => {
        const text = column[row];
        if (text === undefined) return;
        const at = e8.currentColumn();
        if (stops[i] > 0) e8.insert(" ".repeat(Math.max(0, stops[i] - at)));
        e8.insert(text);
      });
      e8.insert("\n");
    }
  } else {
    // Subgroups: each in turn, a blank line between.
    const subs = layout.children.filter((c): c is Layout => typeof c !== "string" && "group" in c);
    subs.forEach((sub, i) => {
      insertGroup(sub, layout);
      if (i < subs.length - 1) e8.insert("\n");
    });
  }
}

/** Shows the menu, in a window along the bottom of the frame, as transient--show. */
function show(): void {
  if (!active) return;
  if (!truthy(e8.variable("transient-show-popup")) && !popupForced) {
    e8.message(`${active.prefix}-  [C-h for help]`);
    return;
  }
  e8.getBufferCreate(BUFFER);
  e8.withCurrentBuffer(BUFFER, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      const groups = active!.layout.filter((l) => !(l.group.hide && truthy(e8.withCurrentBuffer(active!.buffer, l.group.hide) as e8.Value)));
      groups.forEach((layout, i) => {
        insertGroup(layout);
        if (i < groups.length - 1) e8.insert("\n");
      });
      if (truthy(e8.variable("transient-show-common-commands"))) insertCommonCommands();
      e8.gotoChar(e8.pointMin());
    });
    for (const [name, value] of [
      ["mode-line-format", null],
      ["truncate-lines", true],
      ["cursor-type", null],
    ] as const) {
      e8.makeLocalVariable(name);
      e8.setVariable(name, value);
    }
    e8.setBufferModified(false);
  });
  // A menu taller than the frame allows is cut to fit, the window above
  // keeping a few lines, as display-buffer-in-side-window fits the window.
  const wanted = e8.withCurrentBuffer(BUFFER, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()).replace(/\n$/, "").split("\n").length);
  const lines = Math.max(1, Math.min(wanted, e8.frameHeight() - 6));
  const live = active.window !== 0 && e8.windowList().includes(active.window);
  if (live && e8.windowSize(active.window)?.totalHeight !== lines) {
    e8.deleteWindow(active.window);
    active.window = 0;
  }
  if (!live || active.window === 0) {
    const selected = e8.selectedWindow();
    active.window = e8.splitRootWindow("below", -Math.max(1, lines));
    e8.setWindowBuffer(active.window, BUFFER);
    e8.setWindowDedicatedP(active.window, true);
    e8.selectWindow(selected);
  }
}

/** Takes the menu's window away, as transient--delete-window. */
function hide(): void {
  if (active && active.window !== 0 && e8.windowList().includes(active.window)) e8.deleteWindow(active.window);
  if (e8.bufferLiveP(e8.getBuffer(BUFFER))) e8.call("kill-buffer", BUFFER);
  if (active) active.window = 0;
}

/**
 * KEY in E8's notation, as kbd reads transient's: a word that is no one
 * key, such as "-a", is its characters one after another.
 */
function kbdKeys(key: string): string {
  const one = /^(?:[ACHMSs]-)*(?:.|RET|SPC|TAB|ESC|DEL|LFD|NUL|<[^>]+>)$/u;
  return key
    .split(" ")
    .filter((w) => w !== "")
    .flatMap((w) => (one.test(w) ? [w] : [...w]))
    .join(" ");
}

/** Binds the active suffixes' keys, as transient--make-transient-map, and takes over the keyboard. */
function bindKeys(): void {
  const map = e8.makeSparseKeymap();
  for (const s of active!.suffixes) {
    if (s.kind === "information" || !s.key) continue;
    const keys = kbdKeys(s.key);
    if (e8.lookupKey(map, keys) === undefined) e8.defineKey(map, keys, dispatchCommand(s));
  }
  for (const [key, command] of [
    ["C-g", quitOne],
    ["C-q", quitAll],
    ["ESC ESC ESC", quitAll],
    ["C-h", transientHelp],
    ["C-x s", transientSet],
    ["C-x C-s", transientSave],
    ["C-x C-k", transientReset],
    ["C-x p", transientHistoryPrev],
    ["C-x n", transientHistoryNext],
    ["C-x l", transientSetLevel],
    ["C-x t", transientToggleCommon],
    ["C-x a", transientToggleLevelLimit],
  ] as const) {
    if (e8.lookupKey(map, key) === undefined) e8.defineKey(map, key, command);
  }
  e8.setKeymapParent(MAP, null);
  e8.setKeymapParent(MAP, map);
  e8.setKeymapDefault(MAP, prefixes.get(active!.prefix)?.transientNonSuffix ? null : undefinedKey);
  e8.setOverridingMap(MAP);
}

/** The command a suffix's key runs in the menu: one for each key, as transient's infix commands are one for each argument. */
const dispatchers = new Map<string, e8.DefinedCommand>();
function dispatchCommand(s: Suffix): e8.DefinedCommand {
  const name = `transient--dispatch:${s.key}`;
  if (!dispatchers.has(name)) {
    dispatchers.set(name, e8.defineCommand({
      name,
      doc: "Run the suffix of the menu showing that this key is.",
      run: () => {
        const suffix = active?.suffixes.find((x) => x.key === s.key);
        if (suffix) runSuffix(suffix);
      },
    }));
  }
  return dispatchers.get(name)!;
}

// Running.

/** The infix arguments of the menu now, as transient-args gives them while a suffix runs. */
function currentArgs(): string[] {
  if (!active) return [];
  const args: string[] = [];
  for (const s of active.suffixes) {
    if (s.kind !== "infix") continue;
    const value = values.get(s.command);
    if (value === undefined || value === false) continue;
    if (s.infixClass === "option" && s.options.multiValue === "repeat") args.push(...String(value).split(",").map((v) => `${s.argument}${v}`));
    else args.push(s.infixClass === "switch" ? s.argument! : s.infixClass === "switches" ? String(value) : `${s.argument}${value}`);
  }
  return args;
}

/** The arguments a running suffix's prefix has, as transient-args: the menu's, or the prefix's start value. */
let lastArgs: { prefix: string; args: string[] } | undefined;
export function transientArgs(prefix: string | string[]): string[] {
  const names = Array.isArray(prefix) ? prefix : [prefix];
  const current = e8.variable("transient-current-command");
  if (typeof current === "string" && names.includes(current) && lastArgs?.prefix === current) return lastArgs.args;
  return initialValue(names[0]);
}

/** The value of ARG in ARGS: whether a switch is there, or an option's value, as transient-arg-value. */
export function transientArgValue(arg: string, args: string[]): string | boolean | undefined {
  if (!arg.endsWith("=")) return args.includes(arg);
  const base = arg.slice(0, -1);
  const found = args.find((a) => a === base || a.startsWith(arg));
  return found === undefined ? undefined : found.slice(arg.length);
}

/** Runs COMMAND as the suffix of the menu, the menu's arguments in transientArgs, with the keyboard its own. */
function callSuffix(command: string): void {
  const prefix = active!.prefix;
  lastArgs = { prefix, args: currentArgs() };
  e8.setOverridingMap(null);
  e8.letBind({ "transient-current-command": prefix, "transient-current-prefix": prefix }, () => {
    e8.callInteractively(command as e8.CommandName);
  });
}

function runSuffix(s: Suffix): void {
  if (s.inapt) {
    invalid("Inapt command");
    return;
  }
  const kind = behaviour(s);
  if (kind === "infix") {
    readInfix(s);
    refresh();
    return;
  }
  if (kind === "stack" || kind === "recurse") {
    stack.push({ prefix: active!.prefix, values, returnHere: kind === "recurse" });
    const buffer = active!.buffer;
    hide();
    e8.setOverridingMap(null);
    setup(s.command, buffer);
    return;
  }
  if (kind === "stay") {
    pushHistory(active!.prefix, currentArgs());
    try {
      callSuffix(s.command);
    } finally {
      if (active) refresh();
    }
    return;
  }
  if (kind === "return") {
    // Runs, then goes back to the menu this one was entered from.
    const prefix = active!.prefix;
    const args = currentArgs();
    const parent = stack.pop();
    const buffer = active!.buffer;
    exit(false);
    lastArgs = { prefix, args };
    try {
      e8.letBind({ "transient-current-command": prefix, "transient-current-prefix": prefix }, () => e8.callInteractively(s.command as e8.CommandName));
    } finally {
      if (parent && !active) {
        values = parent.values;
        setup(parent.prefix, buffer, true);
      }
    }
    return;
  }
  // Exit: the menu goes, then the suffix runs, still able to read its
  // arguments. A suffix that quits one menu, as casual's do, goes back to
  // the menu before; any other leaves them all, unless this menu was
  // entered to return to the one before.
  const prefix = active!.prefix;
  const args = currentArgs();
  pushHistory(prefix, args);
  const parent = stack.length > 0 && stack[stack.length - 1].returnHere ? stack.pop() : undefined;
  exit(false);
  lastArgs = { prefix, args };
  try {
    e8.letBind({ "transient-current-command": prefix, "transient-current-prefix": prefix }, () => e8.callInteractively(s.command as e8.CommandName));
  } finally {
    if (parent && !active) {
      values = parent.values;
      setup(parent.prefix, e8.currentBuffer(), true);
    } else if (!active) {
      stack.length = 0;
    }
  }
}

/** Shows the menu again and binds its keys, its suffixes' predicates and descriptions worked out afresh. */
function refresh(): void {
  if (!active) return;
  const buffer = e8.bufferLiveP(active.buffer) ? active.buffer : e8.currentBuffer();
  active.buffer = buffer;
  const defs = prefixes.get(active.prefix)!;
  e8.withCurrentBuffer(buffer, () => {
    active!.layout = defs.groups.map((g) => makeLayout(active!.prefix, g)).filter((l): l is Layout => l !== undefined);
  });
  active.suffixes = flatten(active.layout);
  show();
  bindKeys();
}

/** Reads an infix's new value, as transient-infix-read: a switch toggles, an option is read or, when set, unset. */
function readInfix(s: Suffix): void {
  const now = values.get(s.command);
  if (s.infixClass === "switch") {
    values.set(s.command, now ? undefined : true);
    if (!now) unsetIncompatible(s);
    return;
  }
  if (s.infixClass === "switches") {
    // Each press takes the next choice, then none, as transient-switches do.
    const format = s.options.argumentFormat ?? `${s.argument}%s`;
    const args = (s.options.choices ?? []).map((c) => format.replace("%s", c));
    const at = now === undefined ? -1 : args.indexOf(String(now));
    values.set(s.command, at + 1 < args.length ? args[at + 1] : undefined);
    return;
  }
  if (now !== undefined && !s.options.alwaysRead) {
    values.set(s.command, undefined);
    return;
  }
  const prompt = s.options.prompt ?? `${s.argument}`;
  e8.setOverridingMap(null);
  try {
    const initial = typeof now === "string" ? now : undefined;
    const value = s.options.reader
      ? s.options.reader(prompt, initial)
      : s.options.choices
        ? e8.completingRead(prompt, s.options.choices, { requireMatch: true, history: `transient-history:${s.command}` })
        : e8.readString(prompt, { initial, history: `transient-history:${s.command}` });
    values.set(s.command, value === "" && !s.options.allowEmpty ? undefined : value);
    if (values.get(s.command) !== undefined) unsetIncompatible(s);
  } finally {
    e8.setOverridingMap(MAP);
  }
}

/** Unsets the arguments the prefix says cannot go with S's, as transient--set-incompatible. */
function unsetIncompatible(s: Suffix): void {
  const groups = prefixes.get(active?.prefix ?? "")?.incompatible ?? [];
  const mine = s.argument ?? "";
  for (const group of groups) {
    if (!group.some((a) => mine === a || mine.startsWith(a) || a.startsWith(mine))) continue;
    for (const other of active!.suffixes) {
      if (other === s || other.kind !== "infix") continue;
      if (group.some((a) => other.argument === a || (other.argument ?? "").startsWith(a) || a.startsWith(other.argument ?? "\0"))) values.set(other.command, undefined);
    }
  }
}

function invalid(message: string): void {
  e8.ding();
  e8.message(`${message}: \`${e8.thisSingleCommandKeys()}' (Use \`C-g' to abort, \`?' for help)`);
}

/** Sets a prefix's menu up and shows it, as transient-setup. */
function setup(prefix: string, buffer: e8.Buffer, keepValues = false): void {
  const defs = prefixes.get(prefix);
  if (!defs) e8.signal("error", `Not a transient prefix: ${prefix}`);
  active = { prefix, layout: [], suffixes: [], buffer, window: 0 };
  e8.withCurrentBuffer(buffer, () => {
    active!.layout = defs.groups.map((g) => makeLayout(prefix, g)).filter((l): l is Layout => l !== undefined);
  });
  active.suffixes = flatten(active.layout);
  if (!keepValues) values = initValues(active.suffixes, e8.withCurrentBuffer(buffer, () => initialValue(prefix)));
  historyAt = -1;
  popupForced = false;
  e8.setVariable("transient-current-prefix", prefix);
  show();
  bindKeys();
}

/** Leaves the menu, and with ALL every menu it was entered from. */
function exit(all: boolean): void {
  editingLevels = false;
  hide();
  e8.setOverridingMap(null);
  active = undefined;
  if (all) stack.length = 0;
  e8.setVariable("transient-current-prefix", null);
}

const quitOne = e8.defineCommand({
  name: "transient-quit-one",
  doc: "Exit the current transient, returning to the outer one, if any.",
  run: () => {
    // Also from a suffix that runs it once the menu has gone, as casual's Back does.
    const parent = stack.pop();
    const buffer = active?.buffer ?? e8.currentBuffer();
    exit(false);
    if (parent) {
      values = parent.values;
      setup(parent.prefix, buffer, true);
    }
  },
});

const quitAll = e8.defineCommand({
  name: "transient-quit-all",
  doc: "Exit all transients without saving the transient stack.",
  run: () => exit(true),
});

const undefinedKey = e8.defineCommand({
  name: "transient-undefined",
  doc: "Warn the user that the pressed key is not bound to any suffix.",
  run: () => invalid("Unbound suffix"),
});

/** Whether there are menus to go back to, as transient--stack is non-nil. */
export function transientStackP(): boolean {
  return stack.length > 0;
}

/**
 * Defines a transient prefix command NAME, as transient-define-prefix: run,
 * it shows its groups below and takes the keys they show.
 */
export function transientDefinePrefix(name: string, definition: PrefixDefinition): e8.DefinedCommand {
  prefixes.set(name, definition);
  return e8.defineCommand({
    name,
    doc: definition.doc ?? "A transient menu.",
    run: () => {
      if (active) exit(true);
      setup(name, e8.currentBuffer());
    },
  });
}

/**
 * Defines a suffix command NAME with its own key and description, as
 * transient-define-suffix, to put in a layout by its name.
 */
export function transientDefineSuffix(
  name: string,
  definition: SuffixOptions & { key?: string; description?: Description; doc?: string; run: () => unknown },
): e8.DefinedCommand {
  definedSuffixes.set(name, definition);
  return e8.defineCommand({ name, doc: definition.doc ?? "A transient suffix.", run: () => void definition.run() });
}

/** The suffix spec for transient-quit-one and transient-quit-all, for a layout to name. */
transientDefineSuffix("transient-quit-one-suffix", { key: "C-g", description: "Quit", run: () => e8.call(quitOne) });

// The common commands, as transient-common-commands.

let editingLevels = false;
let popupForced = false;

/** Remembers ARGS as PREFIX's latest value, as transient--history-push. */
function pushHistory(prefix: string, args: string[]): void {
  const list = history.get(prefix) ?? [];
  const key = JSON.stringify(args);
  const rest = list.filter((a) => JSON.stringify(a) !== key);
  history.set(prefix, [args, ...rest].slice(0, Number(e8.variable("transient-history-limit") ?? 10)));
}

/** Puts the menu's infixes to ARGS. */
function setArgs(args: string[]): void {
  if (!active) return;
  values = initValues(active.suffixes, args);
  refresh();
}

/** Inserts the common commands below the menu, as transient shows them with C-x t. */
function insertCommonCommands(): void {
  const k = (key: string) => face(key, "transient-key-stay");
  e8.insert("\n");
  const rows: [string, string][][] = [
    [["C-x s  ", "Set"], ["C-x C-s", "Save"], ["C-x C-k", "Reset"]],
    [["C-x p  ", "Previous value"], ["C-x n  ", "Next value"], ["C-x l  ", "Show/hide suffixes"]],
    [["C-x t  ", "Hide common commands"], ["C-x a  ", "Show all"], ["C-h    ", "Help"]],
  ];
  for (const row of rows) {
    row.forEach(([key, desc], i) => {
      e8.insert(" ");
      e8.insert(k(key));
      e8.insert(` ${desc.padEnd(i < row.length - 1 ? 20 : 0)}`);
    });
    e8.insert("\n");
  }
}

const transientSet = e8.defineCommand({
  name: "transient-set",
  doc: "Set the value of the active transient for this session.",
  run: () => {
    if (!active) return;
    setValues.set(active.prefix, currentArgs());
    e8.message(`Set value of ${active.prefix}`);
  },
});
const transientSave = e8.defineCommand({
  name: "transient-save",
  doc: "Save the value of the active transient persistently, in transient-values-file.",
  run: () => {
    if (!active) return;
    const args = currentArgs();
    setValues.set(active.prefix, args);
    getSaved()[active.prefix] = args;
    writeState("transient-values-file", "values.json", getSaved());
    e8.message(`Saved value of ${active.prefix}`);
  },
});
const transientReset = e8.defineCommand({
  name: "transient-reset",
  doc: "Clear the set and saved values of the active transient, going back to its own.",
  run: () => {
    if (!active) return;
    setValues.delete(active.prefix);
    if (getSaved()[active.prefix]) {
      delete getSaved()[active.prefix];
      writeState("transient-values-file", "values.json", getSaved());
    }
    setArgs(defaultValue(active.prefix));
  },
});
const transientHistoryPrev = e8.defineCommand({
  name: "transient-history-prev",
  doc: "Switch to the previous value used for the active transient.",
  run: () => {
    if (!active) return;
    const list = history.get(active.prefix) ?? [];
    if (historyAt + 1 >= list.length) return void e8.message("No previous value");
    historyAt++;
    setArgs(list[historyAt]);
  },
});
const transientHistoryNext = e8.defineCommand({
  name: "transient-history-next",
  doc: "Switch to the next value used for the active transient.",
  run: () => {
    if (!active) return;
    const list = history.get(active.prefix) ?? [];
    if (historyAt <= 0) return void e8.message("No next value");
    historyAt--;
    setArgs(list[historyAt]);
  },
});
const transientToggleCommon = e8.defineCommand({
  name: "transient-toggle-common",
  doc: "Toggle whether common commands are permanently shown.",
  run: () => {
    e8.setVariable("transient-show-common-commands", !truthy(e8.variable("transient-show-common-commands")));
    refresh();
  },
});
const transientToggleLevelLimit = e8.defineCommand({
  name: "transient-toggle-level-limit",
  doc: "Toggle whether to show the suffixes of every level, with their levels.",
  run: () => {
    editingLevels = !editingLevels;
    refresh();
  },
});
const transientSetLevel = e8.defineCommand({
  name: "transient-set-level",
  doc: "Set the level of the menu, or of a suffix: press RET for the menu's own, or a suffix's key, then the level.",
  run: () => {
    if (!active) return;
    const was = editingLevels;
    editingLevels = true;
    refresh();
    e8.setOverridingMap(null);
    try {
      const key = e8.readKeySequence("Set level of (RET for this menu, or a suffix's key): ");
      const prefix = active.prefix;
      const entry = (getLevels()[prefix] ??= {});
      if (key === "RET" || key === "C-m") {
        const n = Number(e8.readString(`Set level for ${prefix} (1-7): `, { initial: String(transientPrefixLevel(prefix)) }));
        if (n >= 1 && n <= 7) entry.level = n;
      } else {
        const s = active.suffixes.find((x) => kbdKeys(x.key) === key);
        if (!s) return void e8.message(`No suffix is bound to ${key}`);
        const n = Number(e8.readString(`Set level for ${s.command} (0-7): `, { initial: String(s.level) }));
        if (n >= 0 && n <= 7) (entry.suffixes ??= {})[s.command] = n;
      }
      writeState("transient-levels-file", "levels.json", getLevels());
    } finally {
      editingLevels = was;
      if (active) refresh();
    }
  },
});
const transientHelp = e8.defineCommand({
  name: "transient-help",
  doc: "Show help for the suffix of the key pressed next, or with C-h again for the menu itself.",
  run: () => {
    if (!active) return;
    if (!truthy(e8.variable("transient-show-popup")) && !popupForced) {
      popupForced = true;
      return refresh();
    }
    e8.setOverridingMap(null);
    let key: string;
    try {
      key = e8.readKeySequence("Help for (key, or C-h for this menu): ");
    } finally {
      e8.setOverridingMap(MAP);
    }
    const prefix = active.prefix;
    const defs = prefixes.get(prefix);
    let target: string | undefined;
    let doc: string | undefined;
    if (key === "C-h") {
      target = prefix;
      if (defs?.manPage) doc = `${defs.doc ?? ""}\n\nSee the man page ${defs.manPage}.`;
    } else {
      const s = active.suffixes.find((x) => kbdKeys(x.key) === key);
      if (!s) return void e8.message(`No suffix is bound to ${key}`);
      if (s.kind === "infix") doc = `${String(describe(s.description) ?? s.argument)} (${s.argument})\n\n${s.options.doc ?? `An argument of ${prefix}.`}`;
      else target = s.command;
    }
    exit(true);
    if (doc !== undefined) {
      e8.getBufferCreate("*Help*");
      e8.withCurrentBuffer("*Help*", () =>
        e8.letBind({ "inhibit-read-only": true }, () => {
          e8.deleteRegion(e8.pointMin(), e8.pointMax());
          e8.insert(`${target ?? ""}${target ? "\n\n" : ""}${doc}\n`);
        }),
      );
      e8.call("display-buffer", "*Help*");
    } else if (target) e8.call("describe-function" as e8.CommandName, target);
  },
});

// Readers, as transient's.

/** Reads a number of at least 1, as transient-read-number-N+. */
export function transientReadNumberNPlus(prompt: string, initial?: string): string {
  for (;;) {
    const s = e8.readString(prompt, { initial });
    if (s === "" || /^[1-9][0-9]*$/.test(s)) return s;
    e8.message("Please enter a natural number (excluding zero).");
  }
}
/** Reads a number of at least 0, as transient-read-number-N0. */
export function transientReadNumberN0(prompt: string, initial?: string): string {
  for (;;) {
    const s = e8.readString(prompt, { initial });
    if (s === "" || /^[0-9]+$/.test(s)) return s;
    e8.message("Please enter a natural number (including zero).");
  }
}
/** Reads a date, as transient-read-date: anything git takes, so as typed. */
export const transientReadDate = (prompt: string, initial?: string): string => e8.readString(prompt, { initial });
/** Reads a file, as transient-read-file. */
export function transientReadFile(prompt: string, initial?: string): string {
  const file = e8.expandFileName(e8.readFileName(prompt, { initial }));
  const dir = e8.fileNameAsDirectory(e8.expandFileName(String(e8.variable("default-directory") ?? ".")));
  return file.startsWith(dir) ? file.slice(dir.length) : file;
}
/** Reads an existing file, as transient-read-existing-file. */
export const transientReadExistingFile = (prompt: string, initial?: string): string => e8.readFileName(prompt, { initial, mustMatch: true });
/** Reads a directory, as transient-read-directory. */
export const transientReadDirectory = (prompt: string, initial?: string): string => e8.readFileName(prompt, { initial, mustMatch: true });
