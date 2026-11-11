// Quick help for newcomers (ADR 0068): C-h h shows a short guide to where
// you are, C-h 8 one to getting started with E8, each a card of about a
// screen in *Help*: what the place is for, the keys that matter there,
// what to try now and what to learn next, with links to Emacs's full help.
// It is a step beyond Emacs, so it is a global minor mode, on by default;
// turned off, the keys, the cards' hints and the startup line go with it.

import { button, describeModeButton, modeMap, prettyModeName, withHelpWindow, type Xref } from "help";

/**
 * A mode's guide, which a package gives with defineGuide. It names commands,
 * never keys: each command's key is looked up when the card is shown, so a
 * key the user rebinds shows as rebound. In its sentences, \\[command]
 * stands for the key that runs a command, as in Emacs's doc strings.
 */
export interface Guide {
  /** The card's title, "Org mode"; the mode's name followed by "mode" when left out. */
  title?: string;
  /** What the mode is for, in a sentence or two. */
  summary: string;
  /** The keys that matter, in groups: each group's name, and its commands with what each does. */
  keys: [group: string, commands: [command: string, what: string][]][];
  /** Things to do now, a sentence each. */
  tryNow?: string[];
  /** What to learn next, a sentence each. */
  learnNext?: string[];
}

/** The guides packages have given, by major mode. */
const guides = new Map<string, Guide>();

/** Give a major mode's guide, which C-h h shows in its buffers. */
export function defineGuide(mode: string, guide: Guide): void {
  guides.set(mode, guide);
}

/** The modes that have guides, for completion and the tests. */
export function guideModes(): string[] {
  return [...guides.keys()];
}

/** The commands a guide names, in its keys and its sentences. */
export function guideCommands(mode: string): string[] {
  const guide = mode === "e8" ? E8_GUIDE : guides.get(mode);
  if (guide === undefined) return [];
  const named = guide.keys.flatMap(([, commands]) => commands.map(([command]) => command));
  for (const text of [guide.summary, ...(guide.tryNow ?? []), ...(guide.learnNext ?? [])]) {
    for (const m of text.matchAll(/\\\[([^\]]+)\]/g)) named.push(m[1]);
  }
  return named;
}

e8.defineFace({
  name: "help-guide-title",
  doc: "The title of a help-guide card, such as Org mode.",
  attributes: { inherit: "outline-1", weight: "bold" },
});
e8.defineFace({ name: "help-guide-heading", doc: "A section of a help-guide card, such as Keys that matter here.", attributes: { inherit: "bold" } });
e8.defineFace({ name: "help-guide-group", doc: "The name of a group of keys on a help-guide card.", attributes: { inherit: "shadow" } });
e8.defineFace({
  name: "help-key-binding",
  doc: "A key in help text, such as C-x C-f on a help-guide card.",
  attributes: { inherit: "font-lock-constant-face" },
});

// --- Keys, looked up when a card is shown ------------------------------------

/** Whether a key is one to show a newcomer: not a mouse, menu or remapping event. */
function showable(keys: string): boolean {
  return !/mouse|menu-bar|tool-bar|tab-bar|<remap>|<header-line>|<mode-line>|<vertical-|<wheel|drag/.test(keys);
}

/**
 * How good a key is to show, smaller being better: keys typed as text before
 * named ones, fewer keys, shorter; and C-SPC before C-@, C-/ before C-_,
 * which a terminal sends for them, as Emacs advertises them.
 */
function keyCost(keys: string): number {
  const named = /<(?!tab>|return>)/.test(keys) ? 1000 : 0;
  const terminal = /C-[@_]/.test(keys) ? 500 : 0;
  // RET, TAB and SPC are one key each, and read better than a letter that does the same, as Dired's RET and e.
  const length = keys.replace(/\b(RET|TAB|SPC)\b/g, "").length;
  return named + terminal + keys.split(" ").length * 100 + length;
}

/** The best of the keys that run a command, or undefined. */
function bestKey(keys: string[]): string | undefined {
  let best: string | undefined;
  for (const k of keys) if (showable(k) && (best === undefined || keyCost(k) < keyCost(best))) best = k;
  return best;
}

/**
 * Finds the keys of commands: where is says in the current buffer, or,
 * for a guide shown for another mode, in that mode's keymap and then in the
 * global map, a key the mode binds hiding the global map's. `runs` says
 * what a key runs there.
 */
type KeyFinder = ((command: string) => string | undefined) & { runs: (keys: string) => string | undefined };

/** Keys as where-is finds them in the selected window's buffer, with its minor modes. */
function keysHere(): KeyFinder {
  return Object.assign((command: string) => bestKey(e8.whereIsInternal(command)), {
    runs: (keys: string) => {
      for (const map of e8.currentActiveMaps()) {
        const binding = e8.lookupKey(map, keys);
        if (binding !== undefined) return typeof binding === "string" ? binding : undefined;
      }
      return undefined;
    },
  });
}

/**
 * Keys as a buffer in a major mode would have them, for a guide shown for a
 * mode other than the current buffer's: the keymaps of the minor modes on
 * here, as global ones such as tab-bar-mode are on there too, then the
 * mode's, then the global map's, each hiding the keys of those after it.
 */
function keysInMode(mode: string | undefined): KeyFinder {
  const byCommand = new Map<string, string[]>();
  const taken = new Map<string, string>();
  const add = (bindings: [string, string][]) => {
    for (const [keys, command] of bindings) {
      if (taken.has(keys)) continue;
      taken.set(keys, command);
      const list = byCommand.get(command);
      if (list === undefined) byCommand.set(command, [keys]);
      else list.push(keys);
    }
  };
  for (const minor of e8.enabledMinorModes()) {
    const minorMap = modeMap(minor);
    if (minorMap !== undefined) add(e8.keymapBindings(minorMap));
  }
  const map = mode === undefined ? undefined : modeMap(mode);
  if (map !== undefined) add(e8.keymapBindings(map));
  add(e8.keymapBindings(e8.currentGlobalMap()));
  return Object.assign((command: string) => bestKey(byCommand.get(command) ?? []), { runs: (keys: string) => taken.get(keys) });
}

/**
 * The global map's keys for each command as E8's packages left them, before
 * init.ts bound any to something else: taken in before-init-hook, as
 * Emacs runs it before the init file, so a card can still name a key a
 * config gave to another command.
 */
let defaultKeys: Map<string, string[]> | undefined;

e8.addHook("before-init-hook", () => {
  defaultKeys = new Map();
  for (const [keys, command] of e8.keymapBindings(e8.currentGlobalMap())) {
    if (!showable(keys)) continue;
    const list = defaultKeys.get(command);
    if (list === undefined) defaultKeys.set(command, [keys]);
    else list.push(keys);
  }
});

/**
 * For a command nothing binds now, a key E8 bound it to that now runs
 * another command, as a config gives C-x b to consult-buffer: the best such
 * key, and what it runs.
 */
function rebound(command: string, find: KeyFinder): { key: string; runs: string } | undefined {
  const keys = [...(defaultKeys?.get(command) ?? [])].sort((a, b) => keyCost(a) - keyCost(b));
  for (const key of keys) {
    const runs = find.runs(key);
    if (runs !== undefined && runs !== command && runs !== "undefined") return { key, runs };
  }
  return undefined;
}

/**
 * How a card names a command's key: the key; else a key E8 bound it to,
 * which now runs something like it; else M-x and the command's name.
 */
function keyText(command: string, find: KeyFinder): string {
  return find(command) ?? rebound(command, find)?.key ?? `M-x ${command}`;
}

/**
 * Text with \\[command] replaced by the command's key, as Emacs's
 * substitute-command-keys: in the current buffer, or in a major mode's
 * keymap and the global map when a mode is given, as for a buffer not
 * shown yet.
 */
export function substituteCommandKeys(text: string, mode?: string): string {
  const find = mode === undefined ? keysHere() : keysInMode(mode);
  return text.replace(/\\\[([^\]]+)\]/g, (_, command: string) => keyText(command, find));
}

// --- Laying a card out -------------------------------------------------------

/** How wide a card's text is filled, as fill-column is for prose. */
const WIDTH = 70;

/**
 * A piece of a card's text: words, perhaps in a face, or a key or a note
 * kept whole, which is never broken across lines.
 */
type Piece = { text: string; key?: boolean; face?: string; whole?: boolean };

/** A sentence's pieces, its \\[command]s made keys. */
function pieces(text: string, find: KeyFinder): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(/\\\[([^\]]+)\]/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: keyText(m[1], find), key: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// Text with faces is inserted as it is or joined with e8.concat: a template
// string would make it a plain string, and the faces would be lost.

/** The face of a key on a card. */
const keyed = (text: string) => e8.propertize(text, { face: "help-key-binding" });

/**
 * Inserts pieces filled to WIDTH: the first line after `column` characters
 * already on it, the others indented by `indent`.
 */
function insertFilled(parts: Piece[], column: number, indent: number): void {
  // Words, keys kept whole, each with whether a space comes before it.
  const words: { text: string; key: boolean; space: boolean; face?: string }[] = [];
  let space = false;
  for (const part of parts) {
    if (part.key || part.whole) {
      // A whole piece starting with a space has one before it, as a note after a sentence.
      const text = part.text.replace(/^\s+/, "");
      words.push({ text, key: part.key === true, space: space || text !== part.text, face: part.face });
      space = false;
      continue;
    }
    const tokens = part.text.split(/(\s+)/);
    for (const token of tokens) {
      if (token === "") continue;
      if (/^\s+$/.test(token)) space = true;
      else {
        // A word right after a key, as its full stop, has no space before it and so stays on its line.
        words.push({ text: token, key: false, space, face: part.face });
        space = false;
      }
    }
  }
  let at = column;
  let first = true;
  for (const word of words) {
    const gap = word.space && !first ? 1 : 0;
    if (!first && at + gap + word.text.length > WIDTH && word.space) {
      e8.insert(`\n${" ".repeat(indent)}`);
      at = indent;
    } else if (gap > 0) {
      e8.insert(" ");
      at += 1;
    }
    e8.insert(word.key ? keyed(word.text) : word.face !== undefined ? e8.propertize(word.text, { face: word.face }) : word.text);
    at += word.text.length;
    first = false;
  }
  e8.insert("\n");
}

/** Inserts a section's heading, after a blank line. */
function insertHeading(text: string): void {
  e8.insert(e8.concat("\n", e8.propertize(text, { face: "help-guide-heading" }), "\n"));
}

/** Inserts sentences as a list, each filled under its bullet. */
function insertList(sentences: Piece[][]): void {
  for (const sentence of sentences) {
    e8.insert("  • ");
    insertFilled(sentence, 4, 4);
  }
}

/** Everything a card shows, worked out where it was asked for, so l and r can show it again unchanged. */
interface Card {
  title: string;
  summary: Piece[];
  /** Each group's name and its rows: the key, and what the command does. */
  keys: [string, [string, Piece[]][]][];
  tryNow: Piece[][];
  learnNext: Piece[][];
  /** The links at the end: a label and where it leads. */
  links: (e8.PropertizedString | string)[];
}

/** A card from a guide, its keys found with `find`; a command no package has defined is left out. */
function makeCard(title: string, guide: Guide, find: KeyFinder, links: Card["links"]): Card {
  return {
    title,
    summary: pieces(guide.summary, find),
    keys: guide.keys
      .map(([group, commands]): [string, [string, Piece[]][]] => [
        group,
        commands.filter(([command]) => e8.commandExists(command)).map(([command, what]): [string, Piece[]] => {
          // A key a config gave to another command is named, with what it runs now.
          const moved = find(command) === undefined ? rebound(command, find) : undefined;
          if (moved === undefined) return [keyText(command, find), pieces(what, find)];
          return [moved.key, [...pieces(what, find), { text: ` (now ${moved.runs})`, face: "shadow", whole: true }]];
        }),
      ])
      .filter(([, rows]) => rows.length > 0),
    tryNow: (guide.tryNow ?? []).map((s) => pieces(s, find)),
    learnNext: (guide.learnNext ?? []).map((s) => pieces(s, find)),
    links,
  };
}

/** Inserts a card into *Help*. */
function insertCard(card: Card): void {
  e8.insert(e8.concat(e8.propertize(card.title, { face: "help-guide-title" }), "\n"));
  insertFilled(card.summary, 0, 0);
  if (card.keys.length > 0) {
    insertHeading("Keys that matter here");
    const rows = card.keys.flatMap(([, r]) => r);
    // The keys line up in a column as wide as the widest key, up to a point; a longer one, as M-x and a
    // command's name, pushes its text along rather than everyone's.
    const keyWidth = Math.max(3, ...rows.map(([key]) => key.length).filter((n) => n <= 10));
    for (const [group, groupRows] of card.keys) {
      e8.insert(e8.concat("  ", e8.propertize(group, { face: "help-guide-group" }), "\n"));
      for (const [key, what] of groupRows) {
        e8.insert(e8.concat("    ", keyed(key), " ".repeat(Math.max(2, keyWidth + 2 - key.length))));
        const column = 4 + Math.max(key.length + 2, keyWidth + 2);
        insertFilled(what, column, 6 + keyWidth);
      }
    }
  }
  if (card.tryNow.length > 0) {
    insertHeading("Try now");
    insertList(card.tryNow);
  }
  if (card.learnNext.length > 0) {
    insertHeading("Learn next");
    insertList(card.learnNext);
  }
  insertHeading("More help");
  for (const link of card.links) {
    e8.insert("  ");
    e8.insert(link);
    e8.insert("\n");
  }
  e8.insert(e8.concat("\n", e8.propertize("RET follows a link, l comes back here, q closes this window.", { face: "shadow" }), "\n"));
}

/** A link: a button, given or made from a label and where it leads, with a key after it when one runs the same. */
function link(target: e8.PropertizedString | [label: string, xref: Xref], command?: string, find?: KeyFinder): e8.PropertizedString {
  const shown = Array.isArray(target) ? button(target[0], target[1]) : target;
  const key = command !== undefined && find !== undefined ? find(command) : undefined;
  return key === undefined ? shown : e8.concat(shown, " ", keyed(`(${key})`));
}

// --- The cards -------------------------------------------------------------

/** The first paragraph of a doc string, its summary. */
function firstParagraph(doc: string | undefined): string {
  return (doc ?? "").split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ").trim();
}

/** The first sentence of a command's doc string, shortened to fit a card's row. */
function shortDoc(command: string): string {
  const line = (e8.documentation(command) ?? "").split("\n")[0];
  const sentence = line.match(/^(.*?[.:;])(\s|$)/)?.[1] ?? line;
  if (sentence.length <= 52) return sentence.replace(/[.:;]$/, "");
  const cut = sentence.slice(0, 51);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 51)}…`;
}

/**
 * A guide for a mode nobody wrote one for, made from what E8 knows of it:
 * its doc string's first paragraph, and the keys its keymap adds to its
 * parent's, as many as fit a card. A mode built on one with a guide, as
 * every programming mode is on Prog mode, takes the rest from that guide.
 */
function madeGuide(mode: string): Guide {
  const map = modeMap(mode);
  const own: [string, string][] = [];
  if (map !== undefined) {
    const parent = e8.keymapParent(map);
    const inherited = new Set((parent === undefined ? [] : e8.keymapBindings(parent)).map(([k, c]) => `${k}\0${c}`));
    const seen = new Set<string>();
    for (const [keys, command] of e8.keymapBindings(map)) {
      if (inherited.has(`${keys}\0${command}`) || !showable(keys) || seen.has(command)) continue;
      if (command === "undefined" || command === "Keyboard Macro" || !e8.commandExists(command)) continue;
      seen.add(command);
      own.push([command, shortDoc(command)]);
    }
  }
  const summary = firstParagraph(e8.documentation(mode)) || `${prettyModeName(mode)} has no documentation yet.`;
  const ownGroup: Guide["keys"] = own.length === 0 ? [] : [["Keys this mode adds", own.slice(0, 10)]];
  const all =
    own.length > 10
      ? `This mode has ${own.length} keys of its own; \\[describe-mode] lists them all.`
      : "\\[describe-mode] says everything about this mode and the minor modes that are on.";
  const parent = guidedParent(mode);
  const base = parent === undefined ? undefined : guides.get(parent);
  if (base !== undefined) {
    return {
      summary: `${summary} It is built on ${base.title ?? prettyModeName(parent!)}.`,
      keys: [...ownGroup, ...base.keys],
      tryNow: base.tryNow,
      learnNext: [...(base.learnNext ?? []).filter((s) => !s.includes("\\[describe-mode]")), all],
    };
  }
  return {
    summary,
    keys: ownGroup,
    learnNext: [...(own.length === 0 ? ["This mode adds no keys of its own; \\[help-guide-e8] has the keys that work everywhere."] : []), all],
  };
}

/** What a card calls the current buffer's major mode: its guide's title, else its mode-name and "mode". */
function placeTitle(mode: string): string {
  const name = e8.variable("mode-name");
  return guides.get(mode)?.title ?? (typeof name === "string" && name !== "" ? `${name} mode` : prettyModeName(mode));
}

/** The mode of the buffer C-h h was last pressed in, which C-h 8 in *Help* takes as where you are. */
let lastPlace: { mode: string; name: string } | undefined;

/**
 * Whether a name is a major mode's: a command with the keymap and hook
 * defineMajorMode makes, and no variable of its own, as a minor mode has.
 */
function isMajorMode(name: string): boolean {
  return e8.commandExists(name) && modeMap(name) !== undefined && e8.isHook(`${name}-hook`) && e8.variable(name) === undefined;
}

/** The nearest mode a mode is built on that has a guide, if any. */
function guidedParent(mode: string): string | undefined {
  return e8.derivedModeAllParents(mode).slice(1).find((m) => guides.has(m));
}

/** The card for a major mode: its guide, or one made from what E8 knows of it. */
function modeCard(mode: string, title: string, find: KeyFinder, fullHelp: e8.PropertizedString | string): Card {
  const guide = guides.get(mode) ?? madeGuide(mode);
  const links: Card["links"] = [fullHelp];
  links.push(link(["Getting started with E8", ["call", "help-guide-e8"]], "help-guide-e8", find));
  links.push(link(["All the help commands", ["call", "help-for-help"]], "help-for-help", find));
  return makeCard(guide.title ?? title, guide, find, links);
}

/** Signals that the cards are off, as a key whose command is not there would. */
function checkOn(): void {
  if (e8.variable("help-guide-mode") !== true) e8.userError("help-guide-mode is off; M-x help-guide-mode turns it on");
}

e8.defineCommand({
  name: "help-guide-here",
  doc:
    "Show a short guide to the current buffer's major mode: what it is for, the keys that matter in it, " +
    "what to try now and what to learn next, with a link to its full help (C-h m).",
  run: () => {
    checkOn();
    const mode = String(e8.variable("major-mode"));
    const find = keysHere();
    const title = placeTitle(mode);
    // Everything is worked out here, in the buffer the card is about, not in *Help*.
    const fullHelp = link(describeModeButton(`Everything about ${title}`), "describe-mode", find);
    const card = modeCard(mode, title, find, fullHelp);
    if (mode !== "help-mode") lastPlace = { mode, name: title };
    withHelpWindow(() => insertCard(card));
  },
});

e8.defineCommand({
  name: "help-guide-for-mode",
  doc: "Show the short guide to a major mode, as C-h h shows it in the mode's buffers.",
  params: [{ name: "mode", prompt: "Guide to mode: ", collection: () => guideModes().sort() }],
  run: (mode) => {
    checkOn();
    if (!isMajorMode(mode)) e8.userError(`${mode} is not a major mode`);
    const find = keysInMode(mode);
    const title = guides.get(mode)?.title ?? prettyModeName(mode);
    const fullHelp = button(`Everything about ${title}`, ["modes", mode, prettyModeName(mode).replace(/ mode$/, "")]);
    const card = modeCard(mode, title, find, fullHelp);
    withHelpWindow(() => insertCard(card));
  },
});

/** The guide to E8 itself, which C-h 8 shows. */
const E8_GUIDE: Guide = {
  summary:
    "E8 is an editor that works the way Emacs works. Everything it does is a command, and keys run commands: " +
    "C-x is Control and x, M-x is Meta and x (Option or Alt, or ESC before x). The arrow keys move as anywhere else.",
  keys: [
    [
      "When you are stuck",
      [
        ["keyboard-quit", "Stop: a command, a prompt, a selection"],
        ["undo", "Undo the last change; again for the one before"],
        ["execute-extended-command", "Run any command by its name, with completion"],
      ],
    ],
    [
      "Files and buffers",
      [
        ["find-file", "Open a file, or start a new one"],
        ["save-buffer", "Save the file"],
        ["switch-to-buffer", "Go to another buffer: an open file, or other text"],
        ["kill-buffer", "Close a buffer"],
      ],
    ],
    [
      "Text",
      [
        ["isearch-forward", "Search as you type; again for the next match"],
        ["set-mark-command", "Start selecting at point; move to select"],
        ["kill-region", "Cut the selection"],
        ["kill-ring-save", "Copy it"],
        ["yank", "Paste"],
      ],
    ],
    [
      "Windows",
      [
        ["other-window", "Move to the next window"],
        ["delete-other-windows", "Keep only this window"],
        ["split-window-right", "Split it side by side"],
      ],
    ],
    ["Leaving", [["save-buffers-kill-terminal", "Quit E8, offering to save what is unsaved"]]],
  ],
  tryNow: [
    "Open a file with \\[find-file], change something, and save it with \\[save-buffer].",
    "Press \\[help-guide-here] in any buffer for a guide to the mode it is in.",
  ],
  learnNext: [
    "\\[describe-key] and then a key says what that key does; \\[describe-function] describes a command.",
    "\\[describe-bindings] lists every key you can press where you are; \\[help-for-help] lists all the help.",
    "Settings go in init.ts in your configuration directory, written in TypeScript.",
    "Know Emacs already? \\[help-guide-mode] turns these guides off; put e8.callWithPrefix(-1, \"help-guide-mode\") in init.ts to keep them off.",
  ],
};

e8.defineCommand({
  name: "help-guide-e8",
  doc: "Show a short guide to getting started with E8: how keys and commands work, the keys to learn first, and where to go next.",
  run: () => {
    checkOn();
    const find = keysHere();
    // Where you are, or, in *Help* itself, the place its last guide was about.
    const mode = String(e8.variable("major-mode"));
    const here = { mode, name: placeTitle(mode) };
    const place = here.mode === "help-mode" && lastPlace !== undefined ? lastPlace : here;
    const links: Card["links"] = [
      link([`Guide to ${place.name}, where you are`, ["call", "help-guide-for-mode", place.mode]], place === here ? "help-guide-here" : undefined, find),
      link(["All the help commands", ["call", "help-for-help"]], "help-for-help", find),
    ];
    // Where init.ts is, as E8 found it: E8_CONFIG_DIR, XDG_CONFIG_HOME/e8 or ~/.config/e8.
    const dir = e8.variable("user-emacs-directory");
    const init = typeof dir === "string" && dir !== "" ? e8.abbreviateFileName(`${dir.replace(/\/$/, "")}/init.ts`) : undefined;
    const guide: Guide = {
      ...E8_GUIDE,
      learnNext: E8_GUIDE.learnNext?.map((s) => (init === undefined ? s : s.replace("init.ts in your configuration directory", init))),
    };
    const card = makeCard("Getting started with E8", guide, find, links);
    withHelpWindow(() => insertCard(card));
  },
});

// --- The mode, which puts the layer on and takes it off ----------------------

const helpGuideMode = e8.defineMinorMode({
  name: "help-guide-mode",
  global: true,
  doc:
    "Quick help for newcomers, on top of Emacs's: C-h h shows a short guide to where you are and C-h 8 one to " +
    "getting started with E8, and E8 says so at startup. Turned off, the keys, the guides and the hints go, " +
    "leaving Emacs's help alone; put e8.callWithPrefix(-1, \"help-guide-mode\") in init.ts for that.",
  onChange: (enabled) => {
    // A key the user bound to something else is theirs: the mode neither takes it nor, turned off, takes it away.
    for (const [key, command] of [["h", "help-guide-here"], ["8", "help-guide-e8"]] as const) {
      const bound = e8.lookupKey("help-map", key);
      if (enabled && bound === undefined) e8.defineKey("help-map", key, command);
      else if (!enabled && bound === command) e8.keymapUnset("help-map", key, true);
    }
  },
});

e8.callWithPrefix(1, helpGuideMode);

// --- The line at startup, as Emacs's "For information about GNU Emacs" -------

/** How many messages E8 had logged when the packages loaded: if init.ts or a package says something after, that stays shown. */
const messagesAtLoad = e8.messages().length;

e8.addHook("emacs-startup-hook", () => {
  if (e8.variable("help-guide-mode") !== true || e8.variable("noninteractive") === true) return;
  if (e8.messages().length !== messagesAtLoad) return;
  e8.message(substituteCommandKeys("Welcome to E8. \\[help-guide-e8] to get started, \\[help-guide-here] for help where you are."));
});
