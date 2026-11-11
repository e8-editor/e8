// Help: the *Help* buffer and its mode, describing keys, commands,
// variables, modes, faces and symbols, listing the keys, finding names by
// apropos, and help on help, after help.el, help-fns.el, help-mode.el and
// apropos.el (ADR 0064). Everything shown is made from E8's own
// definitions and keymaps, never from Emacs's text.

// --- The *Help* buffer, with its history, after help-mode.el ---------------

e8.defineFace({ name: "button", doc: "A button, such as a name in *Help* that RET follows.", attributes: { inherit: "link" } });

/**
 * What a help button leads to, held in the text's help-xref property: a name
 * to describe; the major mode and minor modes whose description C-h m would
 * show; or a command to call, with an argument or none.
 */
export type Xref =
  | ["command" | "variable" | "face" | "key" | "symbol", string]
  | ["modes", string, ...string[]]
  | ["call", string, ...string[]];

/** One thing shown in *Help*: a function that inserts it, so l and r can show it again. */
interface HelpItem {
  render: () => void;
}

/** What *Help* has shown, oldest first, and which of them it shows now. */
const history: HelpItem[] = [];
let shown = -1;

/** Shows an item in *Help*, as with-help-window does: in another window, point at the top. */
function showItem(item: HelpItem): void {
  const buffer = e8.getBufferCreate("*Help*");
  e8.withCurrentBuffer(buffer, () => {
    if (e8.variable("major-mode") !== "help-mode") e8.call("help-mode");
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      item.render();
      e8.gotoChar(e8.pointMin());
    });
    e8.setBufferModified(false);
  });
  e8.call("display-buffer", "*Help*");
}

/** Shows new help, after what *Help* showed before, as help-setup-xref records it. */
export function withHelpWindow(render: () => void): void {
  history.length = shown + 1;
  history.push({ render });
  shown = history.length - 1;
  showItem(history[shown]);
}

/** A name RET follows and TAB finds, as help-mode's buttons. */
export function button(label: string, xref: Xref): e8.PropertizedString {
  return e8.propertize(label, { face: "button", button: true, "help-xref": xref });
}

/** A command's name as a button to its description. */
const commandButton = (name: string) => button(name, ["command", name]);

/** The first line of a doc string, its summary. */
function firstLine(doc: string | undefined): string {
  return (doc ?? "").split("\n")[0];
}

/** The keys of a listing, in Emacs's key order: by the string, prefixes together. */
function keyLess(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inserts a table of keys and commands, as describe-bindings lays one out. */
function insertBindings(bindings: [string, string][]): void {
  e8.insert("Key             Binding\n---             -------\n");
  for (const [keys, command] of bindings) {
    e8.insert(`${keys.padEnd(15)} `);
    e8.insert(e8.commandExists(command) ? commandButton(command) : command);
    e8.insert("\n");
  }
}

// --- Commands and keys, after help-fns.el and help.el -----------------------

/** What the active keymaps bind, the first map's binding of each key winning, flattened through the prefix maps. */
function activeBindings(): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const map of e8.currentActiveMaps()) {
    for (const [keys, command] of e8.keymapBindings(map)) {
      if (seen.has(keys)) continue;
      seen.add(keys);
      out.push([keys, command]);
    }
  }
  return out;
}

/** The keys that run a command now, as where-is lists them: in the window's buffer, its modes' first. */
function keysFor(command: string): string[] {
  return e8.whereIsInternal(command);
}

/** Inserts a command's description: where it is bound, its parameters, its doc string. */
function insertCommand(name: string): void {
  const info = e8.commandInfo(name);
  if (info === undefined) e8.signal("error", `No such command: ${name}`);
  e8.insert(button(name, ["command", name]));
  e8.insert(" is a command");
  if (info.source !== undefined) e8.insert(` defined in ${info.source}`);
  if (info.aliasOf !== undefined) {
    e8.insert(", an alias of ");
    e8.insert(commandButton(info.aliasOf));
  }
  e8.insert(".\n\n");
  const keys = keysFor(name);
  e8.insert(keys.length === 0 ? "It is not bound to any keys.\n\n" : `It is bound to ${keys.join(", ")}.\n\n`);
  if (info.params.length > 0) {
    e8.insert("Parameters:\n");
    for (const p of info.params) e8.insert(`  ${p.name} (${p.description})\n`);
    e8.insert("\n");
  }
  e8.insert(`${info.doc}\n`);
  if (info.shiftSelect) e8.insert("\nWith Shift held, it selects text as it moves (shift selection).\n");
}

/** A key sequence without Shift on each key, as typing a shifted key with no binding of its own falls back to. */
function unshifted(keys: string): string {
  return keys
    .split(" ")
    .map((k) => k.replace(/^((?:[CM]-)*)S-/, "$1"))
    .join(" ");
}

/** Whether a key is a character typing inserts, which runs self-insert-command when nothing binds it. */
function isPrintable(key: string): boolean {
  return key === "SPC" || ([...key].length === 1 && !/[\x00-\x1f\x7f]/.test(key));
}

/** The command a key sequence runs in the active keymaps, as key-binding; a keyboard macro as "Keyboard Macro". */
function keyBinding(keys: string): string | undefined {
  for (const map of e8.currentActiveMaps()) {
    const binding = e8.lookupKey(map, keys);
    if (typeof binding === "string") return binding;
    if (Array.isArray(binding)) return "Keyboard Macro";
  }
  return undefined;
}

/** The command a typed key sequence runs: its binding, the unshifted keys' when it has none, or self-insert-command for a character. */
function commandForKeys(keys: string): string | undefined {
  const found = keyBinding(keys) ?? (unshifted(keys) !== keys ? keyBinding(unshifted(keys)) : undefined);
  if (found !== undefined) return found;
  return !keys.includes(" ") && isPrintable(keys) ? "self-insert-command" : undefined;
}

const describeCommand = e8.defineCommand({
  name: "describe-command",
  doc: "Show what a command does: the keys that run it, its parameters and its documentation.",
  params: [{ name: "command", kind: "command", prompt: "Describe command: " }],
  run: (name) => {
    if (!e8.commandExists(name)) e8.signal("error", `No such command: ${name}`);
    withHelpWindow(() => insertCommand(name));
  },
});

const describeFunction = e8.defineCommand({
  name: "describe-function",
  doc: "Show what a function does: a command as describe-command does, or that a name is a function scripts defined with e8.defun.",
  params: [{ name: "function", prompt: "Describe function: ", collection: () => e8.commandNames() }],
  run: (name) => {
    if (e8.commandExists(name)) {
      withHelpWindow(() => insertCommand(name));
    } else if (e8.fboundp(name)) {
      withHelpWindow(() => e8.insert(`${name} is a function defined with e8.defun, not a command: it runs when a variable names it or code calls it with e8.funcall.\n`));
    } else {
      e8.signal("error", `No such function: ${name}`);
    }
  },
});

const describeKey = e8.defineCommand({
  name: "describe-key",
  doc: "Show which command a key sequence runs, and what the command does.",
  params: [{ name: "key", kind: "keys", prompt: "Describe key: " }],
  run: (keys) => {
    const name = commandForKeys(keys);
    if (name === undefined) e8.signal("error", `${keys} is undefined`);
    withHelpWindow(() => {
      e8.insert(`${keys} runs the command `);
      e8.insert(e8.commandExists(name) ? commandButton(name) : name);
      e8.insert(".\n\n");
      if (e8.commandExists(name)) insertCommand(name);
    });
  },
});

const describeKeyBriefly = e8.defineCommand({
  name: "describe-key-briefly",
  doc: "Say in the echo area which command a key sequence runs.",
  params: [{ name: "key", kind: "keys", prompt: "Describe key briefly: " }],
  run: (keys) => {
    const name = commandForKeys(keys);
    e8.message(name === undefined ? `${keys} is undefined` : `${keys} runs the command ${name}`);
  },
});

const whereIs = e8.defineCommand({
  name: "where-is",
  doc: "Say which keys run a command, in the current buffer.",
  params: [{ name: "command", kind: "command", prompt: "Where is command: " }],
  run: (name) => {
    const keys = keysFor(name);
    e8.message(keys.length === 0 ? `${name} is not on any key` : `${name} is on ${keys.join(", ")}`);
  },
});

/** The keymap a mode's map variable holds, if it has one. */
export function modeMap(mode: string): string | undefined {
  const name = `${mode}-map`;
  return e8.keymapp(e8.variable(name)) ? name : undefined;
}

const describeBindings = e8.defineCommand({
  name: "describe-bindings",
  doc: "List the keys and the commands they run in the current buffer: the major mode's, each minor mode's that is on, and the global ones.",
  run: () => {
    const major = String(e8.variable("major-mode"));
    const sections: [string, string][] = [];
    const majorMap = modeMap(major);
    if (majorMap !== undefined) sections.push(["Major Mode Bindings", majorMap]);
    for (const minor of e8.enabledMinorModes()) {
      const map = modeMap(minor);
      if (map !== undefined) sections.push([`${minor} Minor Mode Bindings`, map]);
    }
    sections.push(["Global Bindings", "global-map"]);
    withHelpWindow(() => {
      for (const [title, map] of sections) {
        const bindings = e8.keymapBindings(map).sort(([a], [b]) => keyLess(a, b));
        if (bindings.length === 0) continue;
        e8.insert(`${title}:\n`);
        insertBindings(bindings);
        e8.insert("\n");
      }
    });
  },
});

e8.defineCommand({
  name: "describe-prefix-bindings",
  doc:
    "List the keys that start with the prefix typed before C-h, and the commands they run.\n\n" +
    "The command loop runs this when C-h or <f1> follows a prefix key that does not bind it, as Emacs's prefix-help-command.",
  run: () => {
    const typed = e8.thisCommandKeysVector();
    const prefix = typed.slice(0, -1).join(" ");
    const under = activeBindings()
      .filter(([keys]) => keys.startsWith(`${prefix} `))
      .sort(([a], [b]) => keyLess(a, b));
    withHelpWindow(() => {
      e8.insert(`Key bindings starting with ${prefix}:\n\n`);
      insertBindings(under);
    });
  },
});

// --- Variables, modes, faces and symbols -------------------------------------

/** A value as a script would write it. */
function showValue(value: e8.Value | undefined): string {
  // Functions and symbols show by name, as Emacs shows a hook's symbols.
  const shown = (_: string, v: unknown) =>
    typeof v === "function" ? v.name || "anonymous function" : typeof v === "symbol" ? v.description : v;
  return value === undefined ? "void" : JSON.stringify(value, shown);
}

/** Whether a name is a variable, as boundp. */
const isVariable = (name: string) => e8.variableDocumentation(name) !== undefined;

/** A variable's value where the command ran, read before *Help* becomes the current buffer. */
interface VariableView {
  value: string;
  /** The buffer's own value: its name and the global value, when it has one. */
  local?: { buffer: string; global: string };
}

/** Reads a variable's value in the current buffer, for insertVariable to show. */
function variableView(name: string): VariableView {
  const view: VariableView = { value: showValue(e8.variable(name)) };
  if (e8.isLocalVariable(name)) view.local = { buffer: e8.bufferName(), global: showValue(e8.defaultValue(name)) };
  return view;
}

/** Inserts a variable's description: its kind, value, local value and doc string. */
function insertVariable(name: string, view: VariableView): void {
  const source = e8.variableSource(name);
  const kind = e8.isHook(name) ? "hook" : "variable";
  e8.insert(button(name, ["variable", name]));
  e8.insert(` is a ${kind}${source ? ` defined in ${source}` : ""}.\n\n`);
  e8.insert(`Its value is ${view.value}\n`);
  if (view.local !== undefined) {
    e8.insert(`  Local in buffer ${view.local.buffer}; global value is ${view.local.global}\n`);
  }
  e8.insert(`\n${e8.variableDocumentation(name)}\n`);
}

const describeVariable = e8.defineCommand({
  name: "describe-variable",
  doc: "Show a variable's documentation, its value in the current buffer, and its global value.",
  params: [{ name: "variable", kind: "variable", prompt: "Describe variable: " }],
  run: (name) => {
    if (!isVariable(name)) e8.signal("error", `No such variable: ${name}`);
    const view = variableView(name);
    withHelpWindow(() => insertVariable(name, view));
  },
});

/** "delete-selection-mode" is "Delete-Selection mode", as Emacs writes it. */
export function prettyModeName(name: string): string {
  return (
    name
      .replace(/-mode$/, "")
      .split("-")
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join("-") + " mode"
  );
}

/** Inserts a mode's description: its name as a button, where it is defined, its doc string and its keys. */
function insertMode(title: string, name: string): void {
  const source = e8.commandSource(name);
  e8.insert(`${title} (`);
  e8.insert(commandButton(name));
  e8.insert(`)${source ? `, defined in ${source}` : ""}:\n\n${e8.documentation(name) ?? ""}\n`);
  const map = modeMap(name);
  if (map === undefined) return;
  const bindings = e8.keymapBindings(map).sort(([a], [b]) => keyLess(a, b));
  if (bindings.length === 0) return;
  e8.insert("\nKey bindings:\n");
  insertBindings(bindings);
}

/** Inserts what describe-mode shows: the major mode, then each minor mode that is on. */
function insertModes(major: string, modeName: string, minors: string[]): void {
  insertMode(`The major mode is ${modeName} mode`, major);
  if (minors.length > 0) {
    e8.insert(`\nMinor modes that are on: ${minors.map(prettyModeName).join(", ")}.\n`);
    for (const minor of minors) {
      e8.insert("\n");
      insertMode(prettyModeName(minor), minor);
    }
  }
}

/**
 * A button to what C-h m shows in the current buffer, for help shown about
 * it from elsewhere, as help-guide's cards link to it.
 */
export function describeModeButton(label: string): e8.PropertizedString {
  const xref: Xref = ["modes", String(e8.variable("major-mode")), String(e8.variable("mode-name")), ...e8.enabledMinorModes()];
  return button(label, xref);
}

const describeMode = e8.defineCommand({
  name: "describe-mode",
  doc: "Show the documentation of the current buffer's major mode and of the minor modes that are on, with their keys.",
  run: () => {
    const major = String(e8.variable("major-mode"));
    const modeName = String(e8.variable("mode-name"));
    const minors = e8.enabledMinorModes();
    withHelpWindow(() => insertModes(major, modeName, minors));
  },
});

/** Inserts a face's description: its doc string, its attributes and what it inherits. */
function insertFace(name: string): void {
  const info = e8.faceInfo(name);
  if (info === undefined) e8.signal("error", `No such face: ${name}`);
  const show = (attrs: e8.FaceAttributes) => (Object.keys(attrs).length === 0 ? "none" : JSON.stringify(attrs));
  e8.insert(button(name, ["face", name]));
  e8.insert(` is a face${info.source ? ` defined in ${info.source}` : ""}.\n\n${info.doc}\n\n`);
  e8.insert(`Its own attributes: ${show(info.attributes)}\n`);
  if (Object.keys(info.dark).length > 0) e8.insert(`  On a dark background: ${show(info.dark)}\n`);
  if (Object.keys(info.light).length > 0) e8.insert(`  On a light background: ${show(info.light)}\n`);
  e8.insert(`\nWith what it inherits, on a dark background: ${show(e8.faceAttributes(name, { dark: true }))}\n`);
  e8.insert(`On a light background: ${show(e8.faceAttributes(name, { dark: false }))}\n`);
}

const describeFace = e8.defineCommand({
  name: "describe-face",
  doc: "Show a face's documentation and attributes, and what it looks like on dark and light backgrounds.",
  params: [{ name: "face", kind: "face", prompt: "Describe face: " }],
  run: (name) => {
    if (e8.faceInfo(name) === undefined) e8.signal("error", `No such face: ${name}`);
    withHelpWindow(() => insertFace(name));
  },
});

/** The name at point: a run of the characters names are made of, as thing-at-point's symbol. */
function symbolAtPoint(): string | undefined {
  const bol = e8.lineBeginningPosition();
  const line = e8.bufferText(bol, e8.lineEndPosition());
  const at = e8.point() - bol;
  const isNameChar = (c: string) => /[A-Za-z0-9_*+<>:/.-]/.test(c);
  let start = at;
  while (start > 0 && isNameChar(line[start - 1])) start--;
  let end = at;
  while (end < line.length && isNameChar(line[end])) end++;
  return end > start ? line.slice(start, end) : undefined;
}

/** Whether a name is a command, a variable or a face, which describe-symbol can show. */
function isSymbol(name: string): boolean {
  return e8.commandExists(name) || isVariable(name) || e8.faceInfo(name) !== undefined;
}

/** Inserts everything a name is: a command, a variable, a face, each its section. */
function insertSymbol(name: string, variable: VariableView | undefined): void {
  const sections: (() => void)[] = [];
  if (e8.commandExists(name)) sections.push(() => insertCommand(name));
  if (variable !== undefined) sections.push(() => insertVariable(name, variable));
  if (e8.faceInfo(name) !== undefined) sections.push(() => insertFace(name));
  sections.forEach((section, i) => {
    if (i > 0) e8.insert("\n\n");
    section();
  });
}

const describeSymbol = e8.defineCommand({
  name: "describe-symbol",
  doc: "Show everything a name is: a command, a variable or a face, each described in turn. Empty input takes the name at point.",
  params: [
    {
      name: "symbol",
      prompt: () => {
        const at = symbolAtPoint();
        return at !== undefined && isSymbol(at) ? `Describe symbol (default ${at}): ` : "Describe symbol: ";
      },
      collection: () => [...e8.commandNames(), ...e8.variableNames(), ...e8.faceList()],
    },
  ],
  run: (name) => {
    if (name === "") {
      const at = symbolAtPoint();
      if (at === undefined || !isSymbol(at)) e8.userError("No symbol here");
      name = at;
    }
    if (!isSymbol(name)) e8.signal("error", `${name} is not a command, a variable or a face`);
    const symbol = name;
    const variable = isVariable(symbol) ? variableView(symbol) : undefined;
    withHelpWindow(() => insertSymbol(symbol, variable));
  },
});

// --- Following links in *Help*, after help-mode.el and button.el ------------

/** Shows what a button leads to. */
function followXref(xref: Xref): void {
  const [kind, name] = xref;
  switch (kind) {
    case "modes": {
      const [, major, modeName, ...minors] = xref;
      withHelpWindow(() => insertModes(major, modeName ?? major, minors));
      break;
    }
    case "call":
      (e8.call as (command: string, ...args: string[]) => unknown)(name, ...xref.slice(2));
      break;
    case "command":
      e8.call("describe-command", name);
      break;
    case "variable":
      e8.call("describe-variable", name);
      break;
    case "face":
      e8.call("describe-face", name);
      break;
    case "key":
      e8.call("describe-key", name);
      break;
    case "symbol":
      e8.call("describe-symbol", name);
      break;
  }
}

/** The link of the button at point, if point is on one. */
function xrefAt(position: number): Xref | undefined {
  const xref = e8.getTextProperty(position, "help-xref");
  return Array.isArray(xref) && xref.length >= 2 ? (xref.map(String) as Xref) : undefined;
}

const helpFollowSymbol = e8.defineCommand({
  name: "help-follow-symbol",
  doc: "Describe the name at point: a command, a variable or a face.",
  run: () => {
    const at = symbolAtPoint();
    if (at === undefined || !isSymbol(at)) e8.userError("No symbol here");
    e8.call("describe-symbol", at);
  },
});

const helpFollow = e8.defineCommand({
  name: "help-follow",
  doc: "Follow the link at point: the button there, or else the name point is on.",
  run: () => {
    const xref = xrefAt(e8.point());
    if (xref !== undefined) followXref(xref);
    else e8.call("help-follow-symbol");
  },
});

/** The start of the next button after a position, or undefined at the end. */
function nextButtonStart(position: number): number | undefined {
  let p: number | undefined = position;
  while (p !== undefined) {
    p = e8.nextSinglePropertyChange(p, "button");
    if (p !== undefined && e8.getTextProperty(p, "button")) return p;
  }
  return undefined;
}

/** The start of the button before a position, or undefined at the start. */
function previousButtonStart(position: number): number | undefined {
  let p: number | undefined = position;
  while (p !== undefined) {
    p = e8.previousSinglePropertyChange(p, "button");
    if (p !== undefined && e8.getTextProperty(p, "button") && !(p > 0 && e8.getTextProperty(p - 1, "button"))) return p;
  }
  return undefined;
}

/** Moves to the nth button on from point, wrapping round the buffer, as forward-button with WRAP. */
function moveToButton(n: number): void {
  const forward = n > 0;
  for (let i = 0; i < Math.abs(n); i++) {
    const found = forward ? nextButtonStart(e8.point()) : previousButtonStart(e8.point());
    if (found !== undefined) {
      e8.gotoChar(found);
      continue;
    }
    const wrapped = forward ? nextButtonStart(e8.pointMin()) : previousButtonStart(e8.pointMax());
    if (wrapped === undefined) e8.userError("No buttons");
    e8.gotoChar(wrapped);
  }
}

const forwardButton = e8.defineCommand({
  name: "forward-button",
  doc: "Move to the next button, going round to the first after the last; with a count, that many on.",
  params: [{ name: "n", kind: "count" }],
  run: (n) => moveToButton(n),
});

const backwardButton = e8.defineCommand({
  name: "backward-button",
  doc: "Move to the previous button, going round to the last before the first; with a count, that many back.",
  params: [{ name: "n", kind: "count" }],
  run: (n) => moveToButton(-n),
});

const helpGoBack = e8.defineCommand({
  name: "help-go-back",
  doc: "Show what *Help* showed before this.",
  run: () => {
    if (shown <= 0) e8.userError("No previous help buffer");
    shown--;
    showItem(history[shown]);
  },
});

const helpGoForward = e8.defineCommand({
  name: "help-go-forward",
  doc: "Show what *Help* showed after this, having gone back.",
  run: () => {
    if (shown >= history.length - 1) e8.userError("No next help buffer");
    shown++;
    showItem(history[shown]);
  },
});

const helpBindings = {
  RET: helpFollow,
  "C-c C-c": helpFollowSymbol,
  TAB: forwardButton,
  "<backtab>": backwardButton,
  l: helpGoBack,
  "C-c C-b": helpGoBack,
  r: helpGoForward,
  "C-c C-f": helpGoForward,
};

e8.defineMajorMode({
  name: "help-mode",
  modeName: "Help",
  parent: "special-mode",
  doc:
    "The major mode of the *Help* buffer. RET follows the name at point to its description, TAB and S-TAB move between the names, " +
    "l and r go back and forward through what was shown, and q goes back to the buffer before it.",
  bindings: helpBindings,
});

// --- Apropos, after apropos.el ------------------------------------------------

/** Whether a name matches an apropos pattern: words separated by spaces, any of which it contains, or an Emacs regexp. */
function aproposMatches(pattern: string, name: string): boolean {
  if (/\s/.test(pattern)) {
    const words = pattern.split(/\s+/).filter((w) => w !== "");
    return words.some((w) => name.includes(w));
  }
  return e8.stringMatch(pattern, name) !== undefined;
}

type AproposKind = "Command" | "Variable" | "Face";

/** Shows names matching a pattern in *Apropos*, each with its summary and, for a command, its keys. */
function apropos(pattern: string, kinds: AproposKind[]): void {
  const entries: [string, AproposKind, string][] = [];
  if (kinds.includes("Command")) {
    for (const name of e8.commandNames()) if (aproposMatches(pattern, name)) entries.push([name, "Command", firstLine(e8.documentation(name))]);
  }
  if (kinds.includes("Variable")) {
    for (const name of e8.variableNames()) if (aproposMatches(pattern, name)) entries.push([name, "Variable", firstLine(e8.variableDocumentation(name))]);
  }
  if (kinds.includes("Face")) {
    for (const name of e8.faceList()) if (aproposMatches(pattern, name)) entries.push([name, "Face", firstLine(e8.faceInfo(name)?.doc)]);
  }
  if (entries.length === 0) e8.userError(`No matches for "${pattern}"`);
  entries.sort(([a], [b]) => keyLess(a, b));
  const buffer = e8.getBufferCreate("*Apropos*");
  e8.withCurrentBuffer(buffer, () => {
    if (e8.variable("major-mode") !== "apropos-mode") e8.call("apropos-mode");
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      for (const [name, kind, summary] of entries) {
        const xref: Xref = kind === "Command" ? ["command", name] : kind === "Variable" ? ["variable", name] : ["face", name];
        e8.insert(button(name, xref));
        if (kind === "Command") {
          const keys = keysFor(name);
          e8.insert(`${" ".repeat(Math.max(1, 30 - name.length))}${keys.length === 0 ? `M-x ${name}` : keys.join(", ")}`);
        }
        e8.insert(`\n  ${kind}: ${summary === "" ? "(not documented)" : summary}\n`);
      }
      e8.gotoChar(e8.pointMin());
    });
    e8.setBufferModified(false);
  });
  e8.call("display-buffer", "*Apropos*");
}

e8.defineMajorMode({
  name: "apropos-mode",
  modeName: "Apropos",
  parent: "special-mode",
  doc: "The major mode of the *Apropos* buffer: RET on a name describes it, TAB and S-TAB move between the names, and q goes back.",
  bindings: helpBindings,
});

const aproposPrompt = (what: string) => `Search for ${what} (word list or regexp): `;

const aproposCommand = e8.defineCommand({
  name: "apropos-command",
  doc: "List the commands whose names match a pattern, with their keys and what they do: words separated by spaces, any of which a name contains, or an Emacs regexp.",
  params: [{ name: "pattern", prompt: aproposPrompt("command") }],
  run: (pattern) => apropos(pattern, ["Command"]),
});

e8.defineCommand({
  name: "apropos-variable",
  doc: "List the variables whose names match a pattern, with what they hold: words separated by spaces, any of which a name contains, or an Emacs regexp.",
  params: [{ name: "pattern", prompt: aproposPrompt("variable") }],
  run: (pattern) => apropos(pattern, ["Variable"]),
});

e8.defineCommand({
  name: "apropos",
  doc: "List the commands, variables and faces whose names match a pattern: words separated by spaces, any of which a name contains, or an Emacs regexp.",
  params: [{ name: "pattern", prompt: aproposPrompt("symbol") }],
  run: (pattern) => apropos(pattern, ["Command", "Variable", "Face"]),
});

// --- The message log and the keys typed lately -----------------------------

e8.defineCommand({
  name: "view-echo-area-messages",
  doc: "Show the *Messages* buffer: the messages shown in the echo area, newest last.",
  run: () => {
    e8.getBufferCreate("*Messages*");
    e8.withCurrentBuffer("*Messages*", () => {
      e8.setReadOnly(false);
      e8.deleteRegion(0, e8.bufferSize());
      const lines = e8.messages();
      e8.insert(lines.length === 0 ? "" : lines.join("\n") + "\n");
      e8.setReadOnly(true);
      e8.setBufferModified(false);
      e8.gotoChar(e8.bufferSize());
    });
    e8.call("display-buffer", "*Messages*");
  },
});

// The keys typed lately, after help.el's view-lossage.

const viewLossage = e8.defineCommand({
  name: "view-lossage",
  doc:
    "Show the keys typed lately and the commands they ran, oldest first.\n\n" +
    "Each line is the keys of one command, with the command as a comment. lossage-size says how many keys are kept.",
  run: () => {
    // As view-lossage writes them: the keys separated by spaces, a line a
    // command, its name a comment indented to column 24 with tabs, as
    // comment-indent leaves it, or a space after keys that reach past it.
    let text = "";
    let line = "";
    for (const entry of e8.recentKeys(true)) {
      if (typeof entry === "string") {
        line += ` ${entry}`;
        continue;
      }
      const column = line.length;
      const indent = column >= 24 ? " " : "\t".repeat(3 - Math.floor(column / 8));
      text += `${line}${indent};; ${entry.command}\n`;
      line = "";
    }
    const whole = text + line;
    withHelpWindow(() => e8.insert(whole));
  },
});

// --- Help on help, after help.el's help-for-help -----------------------------

const helpForHelp = e8.defineCommand({
  name: "help-for-help",
  doc: "List the help commands: each key after C-h, its command and what it does.",
  run: () => {
    const bindings = e8.keymapBindings("help-map").sort(([a], [b]) => keyLess(a, b));
    withHelpWindow(() => {
      e8.insert("Help is on C-h (or <f1>) followed by one of these keys. C-h after a prefix key, such as C-x C-h, lists the keys under it.\n\n");
      for (const [keys, command] of bindings) {
        e8.insert(`C-h ${keys}`.padEnd(10));
        e8.insert(commandButton(command));
        e8.insert(`: ${firstLine(e8.documentation(command))}\n`);
      }
    });
  },
});

// --- The keys, as help.el's help-map ----------------------------------------

e8.bindKey("C-h a", aproposCommand);
e8.bindKey("C-h b", describeBindings);
e8.bindKey("C-h c", describeKeyBriefly);
e8.bindKey("C-h e", "view-echo-area-messages");
e8.bindKey("C-h f", describeFunction);
e8.bindKey("C-h k", describeKey);
e8.bindKey("C-h l", viewLossage);
e8.bindKey("C-h m", describeMode);
e8.bindKey("C-h o", describeSymbol);
e8.bindKey("C-h v", describeVariable);
e8.bindKey("C-h w", whereIs);
e8.bindKey("C-h x", describeCommand);
e8.bindKey("C-h ?", helpForHelp);
e8.bindKey("C-h C-h", helpForHelp);
// <f1> is help too, as in Emacs: the same prefix map as C-h.
e8.bindKey("<f1>", e8.variable("help-map") as e8.Keymap);
