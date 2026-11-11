// Basic functions packages share, after Emacs's subr.el and subr-x.el.
// Import them by feature name, as Lisp requires subr-x:
//
//   import { truthy, forwardLine } from "subr";

/** Whether a value counts as true, as anything but nil does in Emacs: not null, undefined or false. */
export const truthy = (v: e8.Value | undefined): boolean => v !== undefined && v !== null && v !== false;

/** A variable's value as a number, or `fallback` if it is not one. */
export function numberValue(name: string, fallback: number): number {
  const v = e8.variable(name);
  return typeof v === "number" ? v : fallback;
}

/** A regexp matching `s` itself, as Emacs's regexp-quote. */
export const regexpQuote = (s: string): string => s.replace(/[[*.\\?+^$]/g, "\\$&");

/** A JavaScript regexp's source matching `s` itself, for a package's own regexps; regexpQuote is for Emacs's. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The matches of a global regexp in a string, as `text.matchAll(re)` gives
 * them, without the copy of the regexp that matchAll makes on each call,
 * which QuickJS builds by compiling it again.
 */
export function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const from = re.lastIndex;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    found.push(m);
    if (m[0] === "") re.lastIndex += re.unicode && (text.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
  }
  re.lastIndex = from;
  return found;
}

/** How many characters a string has, as buffer positions count them, not UTF-16 units. */
export function charCount(s: string): number {
  return /[\uD800-\uDFFF]/.test(s) ? Array.from(s).length : s.length;
}

/**
 * Moves point `n` lines forward, back if negative, to the start of a line,
 * as Emacs's forward-line: within the accessible text, returning how many
 * lines it fell short.
 */
export function forwardLine(n: number): number {
  const start = e8.point();
  const line = e8.lineOf(start);
  const first = e8.lineOf(e8.pointMin());
  const last = e8.lineOf(e8.pointMax());
  if (n <= 0) {
    e8.gotoChar(Math.max(e8.pointMin(), e8.lineStart(Math.max(first, line + n))));
    return Math.min(0, line + n - first);
  }
  if (line + n <= last) {
    e8.gotoChar(e8.lineStart(line + n));
    return 0;
  }
  e8.gotoChar(e8.pointMax());
  let shortfall = n - (last - line);
  if (e8.point() !== start && e8.bufferText(e8.point() - 1, e8.point()) !== "\n") shortfall--;
  return shortfall;
}

// Emacs's names for what a line of E8's API does, so a port reads as the
// Lisp it follows. Each returns undefined where Emacs returns nil.

/** Whether point is at the end of the accessible text, as eobp. */
export const eobp = (): boolean => e8.point() === e8.pointMax();
/** Whether point is at the start of the accessible text, as bobp. */
export const bobp = (): boolean => e8.point() === e8.pointMin();
/** Whether point is at the start of a line or of the accessible text, as bolp, fields or not. */
export const bolp = (): boolean => e8.point() === e8.pointMin() || e8.point() === e8.lineStart(e8.lineOf(e8.point()));
/** Whether point is at the end of a line or of the accessible text, as eolp, fields or not. */
export const eolp = (): boolean => e8.point() === e8.pointMax() || e8.point() === e8.lineEnd(e8.lineOf(e8.point()));

/** The accessible text of the current buffer, with its properties, as buffer-string. */
export const bufferString = (): e8.PropertizedString => e8.bufferSubstring(e8.pointMin(), e8.pointMax());

/** Delete the whole of the current buffer's text, narrowed or not, as erase-buffer. */
export function eraseBuffer(): void {
  e8.widen();
  e8.deleteRegion(e8.pointMin(), e8.pointMax());
}

function region(): [number, number] {
  const mark = e8.mark();
  if (mark === undefined) e8.signal("error", "The mark is not set now, so there is no region");
  return [Math.min(e8.point(), mark), Math.max(e8.point(), mark)];
}
/** Where the region starts, as region-beginning: an error when there is no mark. */
export const regionBeginning = (): number => region()[0];
/** Where the region ends, as region-end: an error when there is no mark. */
export const regionEnd = (): number => region()[1];

/** A new marker at point, as point-marker. */
export const pointMarker = (): e8.Marker => e8.makeMarker(e8.point());
/** A new marker at the start of the accessible text, as point-min-marker. */
export const pointMinMarker = (): e8.Marker => e8.makeMarker(e8.pointMin());
/** A new marker at the end of the accessible text, as point-max-marker. */
export const pointMaxMarker = (): e8.Marker => e8.makeMarker(e8.pointMax());
/**
 * A new marker where a marker or position is, advancing on insertion there
 * if `type`, as copy-marker; undefined for a marker that points nowhere.
 */
export function copyMarker(marker: e8.MarkerLike, type = false): e8.Marker | undefined {
  const pos = typeof marker === "number" ? marker : e8.markerPosition(marker);
  if (pos === undefined) return undefined;
  const buffer = typeof marker === "number" ? e8.currentBuffer() : e8.markerBuffer(marker);
  if (buffer === undefined) return undefined;
  const at = Math.max(0, Math.min(pos, e8.withCurrentBuffer(buffer, () => e8.bufferSize())));
  return e8.makeMarker(at, { buffer, advances: type });
}

/** Insert `count` copies of a character, inheriting properties if `inherit`, as insert-char. */
export function insertChar(char: string | number, count = 1, inherit = false): void {
  if (count <= 0) return;
  const text = (typeof char === "number" ? String.fromCodePoint(char) : char).repeat(count);
  if (inherit) e8.insertAndInherit(text);
  else e8.insert(text);
}

/** The names of the text properties anywhere from start to end. */
function propertyNames(start: number, end: number): Set<string> {
  const names = new Set<string>();
  for (let p: number | undefined = start; p !== undefined && p < end; p = e8.nextPropertyChange(p, end)) {
    for (const name of Object.keys(e8.textPropertiesAt(p))) names.add(name);
  }
  return names;
}

/**
 * Give the text from start to end each of `properties`, as
 * add-text-properties; whether any changed.
 */
export function addTextProperties(start: number, end: number, properties: { [name: string]: e8.Value }): boolean {
  let changed = false;
  for (const [name, value] of Object.entries(properties)) {
    if (e8.textPropertyNotAll(start, end, name, value) === undefined) continue;
    e8.putTextProperty(start, end, name, value);
    changed = true;
  }
  return changed;
}

/** Remove the named text properties from start to end, as remove-text-properties; whether any were there. */
export function removeTextProperties(start: number, end: number, names: string[] | { [name: string]: unknown }): boolean {
  const there = propertyNames(start, end);
  let changed = false;
  for (const name of Array.isArray(names) ? names : Object.keys(names)) {
    if (!there.has(name)) continue;
    e8.removeTextProperty(start, end, name);
    changed = true;
  }
  return changed;
}

/** Remove the text properties a list names from start to end, as remove-list-of-text-properties. */
export const removeListOfTextProperties = (start: number, end: number, names: string[]): boolean =>
  removeTextProperties(start, end, names);

/**
 * Make `properties` the only text properties from start to end, none if
 * undefined, as set-text-properties, which returns t.
 */
export function setTextProperties(start: number, end: number, properties?: { [name: string]: e8.Value }): boolean {
  for (const name of propertyNames(start, end)) e8.removeTextProperty(start, end, name);
  if (properties) addTextProperties(start, end, properties);
  return true;
}

/**
 * The value of a property at a position, as get-char-property: from the
 * overlay there with the highest priority that has it, among equals the
 * one starting later, then the one ending sooner, else the text property.
 */
export function getCharProperty(position: number, name: string): e8.Value | undefined {
  return getCharPropertyAndOverlay(position, name)[0];
}

/**
 * The value of a property at a position and the overlay it came from, as
 * get-char-property-and-overlay: undefined for the overlay when it is the
 * text's property, or nobody's.
 */
export function getCharPropertyAndOverlay(position: number, name: string): [e8.Value | undefined, number | undefined] {
  let best: number | undefined;
  let bestPriority = -Infinity;
  for (const ov of e8.overlaysAt(position)) {
    if (e8.overlayGet(ov, name) === undefined) continue;
    const p = e8.overlayGet(ov, "priority");
    const priority = typeof p === "number" ? p : 0;
    const start = e8.overlayStart(ov) ?? 0, bestStart = best === undefined ? 0 : (e8.overlayStart(best) ?? 0);
    const narrower = best !== undefined && (start > bestStart || (start === bestStart && (e8.overlayEnd(ov) ?? 0) < (e8.overlayEnd(best) ?? 0)));
    if (best === undefined || priority > bestPriority || (priority === bestPriority && narrower)) {
      best = ov;
      bestPriority = priority;
    }
  }
  return best !== undefined ? [e8.overlayGet(best, name), best] : [e8.getTextProperty(position, name), undefined];
}

/** Nothing: E8's overlays need no recentering, as Emacs's no longer do either. */
export function overlayRecenter(_position: number): void {}

/**
 * A new overlay with the same buffer, place and properties as another, as
 * copy-overlay; undefined for a deleted one, as E8 has no overlays in no buffer.
 */
export function copyOverlay(overlay: number): number | undefined {
  const buffer = e8.overlayBuffer(overlay);
  const props = e8.overlayProperties(overlay);
  if (buffer === undefined || props === undefined) return undefined;
  return e8.withCurrentBuffer(buffer, () => e8.makeOverlay(e8.overlayStart(overlay)!, e8.overlayEnd(overlay)!, props));
}

/**
 * Clear from start to end, the accessible text by default, the overlays
 * whose property `name` is `value`, every overlay without a name, as
 * remove-overlays: one reaching outside the range is cut back to the part
 * outside, split in two if it reaches out both ends.
 */
export function removeOverlays(start = e8.pointMin(), end = e8.pointMax(), name?: string, value?: e8.Value): void {
  if (start > end) [start, end] = [end, start];
  for (const o of e8.overlaysIn(start, end)) {
    if (name !== undefined && (e8.overlayGet(o, name) ?? null) !== (value ?? null)) continue;
    const os = e8.overlayStart(o)!, oe = e8.overlayEnd(o)!;
    if (os < start) {
      // The original keeps the part after, a copy the part before, as Emacs's.
      if (oe > end) {
        e8.moveOverlay(copyOverlay(o)!, os, start);
        e8.moveOverlay(o, end, oe);
      } else {
        e8.moveOverlay(o, os, start);
      }
    } else if (oe > end) {
      e8.moveOverlay(o, end, oe);
    } else {
      e8.deleteOverlay(o);
    }
  }
}

/** Whether a window is live, showing a buffer on any frame, as window-live-p. */
export const windowLiveP = (window: unknown): boolean => typeof window === "number" && e8.windowBuffer(window) !== undefined;
/** Whether a frame is live, as frame-live-p. */
export const frameLiveP = (frame: unknown): boolean => typeof frame === "number" && e8.frameList().includes(frame);
/** A window showing a buffer, the current one by default, as get-buffer-window: the selected window first. */
export function getBufferWindow(buffer?: e8.BufferLike): number | undefined {
  const name = buffer === undefined ? e8.bufferName(e8.currentBuffer()) : e8.bufferName(buffer);
  if (name === undefined) return undefined;
  const selected = e8.selectedWindow();
  if (e8.windowBuffer(selected) === name) return selected;
  return e8.windowList().find((w) => e8.windowBuffer(w) === name);
}
/** The minibuffer's window while a minibuffer is open, as active-minibuffer-window. */
export const activeMinibufferWindow = (): number | undefined => (e8.minibufferDepth() > 0 ? e8.minibufferWindow() : undefined);
/** Whether a window, the selected one by default, is the minibuffer's, as window-minibuffer-p. */
export const windowMinibufferP = (window?: number): boolean => (window ?? e8.selectedWindow()) === e8.minibufferWindow();

/** The process with a name, as get-process: E8 names processes by their names. */
export const getProcess = (name: string): string | undefined => (e8.processList().includes(name) ? name : undefined);
/** Whether a value is a process E8 knows, as processp. */
export const processp = (process: unknown): boolean => typeof process === "string" && e8.processStatus(process) !== undefined;
/** A process's name, as process-name: the name is the process. */
export const processName = (process: string): string => process;

/** Whether a file name names a directory, ending in a slash, as directory-name-p. */
export const directoryNameP = (name: string): boolean => name.endsWith("/");

/**
 * Signal buffer-read-only if the current buffer is read-only, unless
 * inhibit-read-only is set or the text at `position` has an
 * inhibit-read-only property, as barf-if-buffer-read-only.
 */
export function barfIfBufferReadOnly(position: number = e8.point()): void {
  if (!e8.bufferReadOnly() || truthy(e8.variable("inhibit-read-only"))) return;
  if (truthy(e8.getTextProperty(position, "inhibit-read-only"))) return;
  e8.signal("buffer-read-only", `Buffer is read-only: ${e8.bufferName(e8.currentBuffer())}`);
}

/** Whether the first element of `a` is less than the first of `b`, as car-less-than-car, for sorting. */
export const carLessThanCar = (a: [number, ...unknown[]], b: [number, ...unknown[]]): boolean => a[0] < b[0];

e8.defineCommand({
  name: "global-set-key",
  doc: "Bind a key sequence to a command in the global keymap, as Emacs's global-set-key: every buffer sees it unless a local binding shadows it.",
  params: [
    { name: "key", kind: "keys", prompt: "Set key globally: " },
    { name: "command", kind: "command", prompt: (key) => `Set key ${key} to command: ` },
  ],
  run: (key, command) => {
    e8.defineKey(e8.currentGlobalMap(), key, command);
  },
});

e8.defineCommand({
  name: "local-set-key",
  doc: "Bind a key sequence to a command in the current buffer's local map, as Emacs's local-set-key: the major mode's keymap, so every buffer in that mode sees it.",
  params: [
    { name: "key", kind: "keys", prompt: "Set key locally: " },
    { name: "command", kind: "command", prompt: (key) => `Set key ${key} locally to command: ` },
  ],
  run: (key, command) => {
    let map = e8.currentLocalMap();
    if (map === undefined) {
      map = e8.makeSparseKeymap();
      e8.useLocalMap(map);
    }
    e8.defineKey(map, key, command);
  },
});

e8.defineCommand({
  name: "global-unset-key",
  doc: "Take a key sequence's binding out of the global keymap, as Emacs's global-unset-key.",
  params: [{ name: "key", kind: "keys", prompt: "Unset key globally: " }],
  run: (key) => {
    e8.defineKey(e8.currentGlobalMap(), key, null);
  },
});

e8.defineCommand({
  name: "local-unset-key",
  doc: "Take a key sequence's binding out of the current buffer's local map, as Emacs's local-unset-key.",
  params: [{ name: "key", kind: "keys", prompt: "Unset key locally: " }],
  run: (key) => {
    const map = e8.currentLocalMap();
    if (map !== undefined) e8.defineKey(map, key, null);
  },
});

e8.defineCommand({
  name: "delete-minibuffer-contents",
  doc: "Delete all the input in the minibuffer, leaving the prompt.",
  run: () => {
    e8.deleteRegion(e8.minibufferPromptEnd(), e8.pointMax());
  },
});

e8.defineCommand({
  name: "undefined",
  doc: "Beep and say the keys typed do nothing here, as keys bound to this command, to hide a binding, do.",
  run: () => {
    e8.ding();
    e8.message(`${e8.thisSingleCommandKeys()} is undefined`);
  },
});

e8.defineVariable({
  name: "read-hide-char",
  doc: "The character read-passwd shows in place of each character of a password; * when nil.",
  value: null,
});
e8.defineVariable({
  name: "read-passwd--hide-password",
  doc: "Whether the password being read is shown as read-hide-char rather than as typed.",
  value: true,
});

/** Shows each character of the input as read-hide-char, or as typed while visible, as read-passwd--hide-password. */
function hidePassword(): void {
  const hide = truthy(e8.variable("read-passwd--hide-password"));
  const shown = String(e8.variable("read-hide-char") ?? "*");
  const [beg, end] = [e8.minibufferPromptEnd(), e8.pointMax()];
  if (beg === end) return;
  // One string for the whole input: E8 joins adjacent display strings
  // that are equal, where Emacs keeps each character's own string apart.
  e8.letBind({ "inhibit-read-only": true }, () => {
    if (hide) e8.putTextProperty(beg, end, "display", shown.repeat(end - beg));
    else e8.removeTextProperty(beg, end, "display");
    e8.putTextProperty(beg, end, "help-echo", "C-u: Clear password\nTAB: Toggle password visibility");
  });
}

e8.defineCommand({
  name: "read-passwd-toggle-visibility",
  doc: "Show the password being read as typed, or hide it again.",
  run: () => {
    e8.setVariable("read-passwd--hide-password", !truthy(e8.variable("read-passwd--hide-password")));
    hidePassword();
  },
});

e8.defineMinorMode({
  name: "read-passwd-mode",
  doc: "Hide the password being read in the minibuffer: C-u clears it and TAB shows or hides it.",
  bindings: { "C-u": "delete-minibuffer-contents", TAB: "read-passwd-toggle-visibility" },
  onChange: (on) => {
    e8.setVariable("read-passwd--hide-password", false);
    if (on) e8.call("read-passwd-toggle-visibility");
  },
});

/**
 * Reads a password in the minibuffer, as Emacs's read-passwd: what is
 * typed shows as read-hide-char, is kept in no history and is left out
 * of recent-keys, and the minibuffer is emptied afterwards. With
 * `confirm`, reads it twice and starts over until both agree.
 */
export async function readPasswd(prompt: string, confirm = false, def?: string): Promise<string> {
  if (confirm) {
    for (;;) {
      const first = await readPasswd(prompt, false, def);
      const second = await readPasswd("Confirm password: ", false, def);
      if (first === second) return first;
      e8.message("Password not repeated accurately; please start over");
      await e8.sitFor(1);
    }
  }
  const setup = () => {
    e8.removeHook("minibuffer-setup-hook", setup);
    for (const name of ["inhibit--record-char", "show-paren-mode"]) e8.makeLocalVariable(name);
    e8.setVariable("inhibit--record-char", true);
    e8.setVariable("show-paren-mode", false);
    e8.call("read-passwd-mode");
    e8.addHook("post-command-hook", hidePassword, { local: true });
  };
  e8.addHook("minibuffer-setup-hook", setup);
  try {
    return await e8.letBind({ "enable-recursive-minibuffers": true }, () => e8.readString(prompt, { default: def, history: "t" }));
  } finally {
    e8.removeHook("minibuffer-setup-hook", setup);
  }
}

/**
 * A string that can be put in left-to-right text without the right-to-left
 * text in it taking the punctuation after it along, as Emacs's
 * bidi-string-mark-left-to-right: with an invisible left-to-right mark
 * after it if it has a right-to-left character.
 */
export function bidiStringMarkLeftToRight(str: string): string | e8.PropertizedString {
  if (typeof str !== "string") e8.signal("wrong-type-argument", "Wrong type argument: stringp", [str]);
  return e8.stringMatch("\\cR", str) === undefined ? str : e8.concat(str, e8.propertize("\u200e", { invisible: true }));
}

/**
 * State a package keeps for each buffer, as a buffer-local variable holds
 * it: found by the buffer, given as a name or a buffer object, through its
 * id, so it follows a buffer that is renamed, and forgotten when the
 * buffer is killed.
 */
/**
 * A global mode that turns a buffer's mode on in every buffer, and in those
 * made later as their major modes start, as easy-mmode's
 * define-globalized-minor-mode does with a function that turns MODE on.
 */
export function defineGlobalizedMinorMode(name: string, mode: e8.CommandName, doc: string): e8.DefinedCommand {
  const turnOn = () => {
    if (e8.variable(name) === true && !e8.bufferName().startsWith(" ") && e8.variable(mode) !== true) e8.callWithPrefix(1, mode);
  };
  return e8.defineMinorMode({
    name,
    global: true,
    doc,
    onChange: (enabled) => {
      for (const b of e8.bufferList()) {
        if (b.startsWith(" ")) continue;
        e8.withCurrentBuffer(b, () => {
          if (enabled) turnOn();
          else if (e8.variable(mode) === true) e8.callWithPrefix(-1, mode);
        });
      }
      if (enabled) e8.addHook("after-change-major-mode-hook", turnOn);
      else e8.removeHook("after-change-major-mode-hook", turnOn);
    },
  });
}

/** Where a program is along PATH, as executable-find. */
export function executableFind(program: string): string | undefined {
  if (program.includes("/")) return e8.fileExecutableP(e8.expandFileName(program)) ? program : undefined;
  for (const dir of (e8.getenv("PATH") ?? "").split(":")) {
    if (dir && e8.fileExecutableP(`${dir}/${program}`)) return `${dir}/${program}`;
  }
  return undefined;
}

export class PerBuffer<T> {
  private readonly values = new Map<number, T>();

  constructor() {
    perBufferValues.push(this.values);
  }

  private static id(buffer: string | e8.Buffer): number | undefined {
    return typeof buffer === "string" ? e8.getBuffer(buffer)?.id : buffer.id;
  }

  get(buffer: string | e8.Buffer): T | undefined {
    const id = PerBuffer.id(buffer);
    return id === undefined ? undefined : this.values.get(id);
  }

  has(buffer: string | e8.Buffer): boolean {
    const id = PerBuffer.id(buffer);
    return id !== undefined && this.values.has(id);
  }

  set(buffer: string | e8.Buffer, value: T): void {
    const id = PerBuffer.id(buffer);
    if (id !== undefined) this.values.set(id, value);
  }

  delete(buffer: string | e8.Buffer): void {
    const id = PerBuffer.id(buffer);
    if (id !== undefined) this.values.delete(id);
  }

  /** Forgets every buffer's value. */
  clear(): void {
    this.values.clear();
  }
}

const perBufferValues: Map<number, unknown>[] = [];

e8.addHook("kill-buffer-hook", () => {
  const id = e8.currentBuffer().id;
  for (const values of perBufferValues) values.delete(id);
});
