// Builds the `e8` global from the native functions. Runs once, before any user script.
"use strict";
(() => {
  const native = globalThis.__e8;
  delete globalThis.__e8;
  // The natives that are e8's functions as they are, from their table.
  const api = globalThis.__e8Api;
  delete globalThis.__e8Api;

  // Hook ids by function, so a function can be removed by passing it again.

  // Major modes by name, for building a mode on its parent.
  const majorModes = new Map();
  // How many times e8.load has loaded a package again, for each a module name of its own.
  let loads = 0;
  const isTrue = (value) => value !== null && value !== undefined && value !== false;
  // "delete-selection-mode" is called "Delete-Selection mode" in messages, as in Emacs.
  const prettyName = (name) =>
    name
      .replace(/-mode$/, "")
      .split("-")
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join("-");

  function bindAll(keymap, bindings) {
    for (const [keys, command] of Object.entries(bindings ?? {})) {
      native.bindKey(String(keys), command instanceof Keymap ? command : String(command), keymap);
    }
  }

  // Turns on a major mode, as Emacs's define-derived-mode does: clear the
  // buffer's own variables, set up each mode from the root down, then run
  // their hooks, parent's first.
  function enterMajorMode(name) {
    const chain = [];
    for (let mode = majorModes.get(name); mode; mode = mode.parent === null ? undefined : majorModes.get(mode.parent)) {
      chain.unshift(mode);
    }
    native.killAllLocalVariables();
    for (const mode of chain) {
      native.setVariable("major-mode", mode.name);
      native.setVariable("mode-name", mode.modeName);
      native.useLocalMap(mode.keymap);
      native.setSyntaxTable(mode.syntaxTable);
      if (mode.setup) mode.setup();
    }
    for (const mode of chain) native.runHooks(`${mode.name}-hook`);
    // As run-mode-hooks: a file's buffer takes up its local variables
    // once the mode's hooks have run (files.ts defines how).
    if (native.bufferFileName() !== undefined && native.fboundp("hack-local-variables")) {
      try {
        globalThis.e8.funcall("hack-local-variables", Symbol.for("no-mode"));
      } catch (e) {
        if (e?.symbol === "quit") throw e;
        native.message(`File local-variables error: ${e?.message ?? String(e)}`);
      }
    }
    native.runHooks("after-change-major-mode-hook");
  }

  /**
   * A buffer as an object, as Emacs's buffer objects: it keeps referring to
   * the buffer when it is renamed, and is the same object each time. Where
   * a buffer's name is taken, its current name is used.
   */
  const buffers = new Map();
  class Buffer {
    constructor(id) {
      Object.defineProperty(this, "__e8BufferId", { value: id });
      Object.freeze(this);
    }
    get id() {
      return this.__e8BufferId;
    }
    /** Its name now, or undefined once it is killed. */
    get name() {
      return native.bufferNameOf(this.__e8BufferId) ?? undefined;
    }
    get live() {
      return this.name !== undefined;
    }
    toString() {
      return this.name ?? "#<killed buffer>";
    }
    /** As Emacs prints a buffer, for help and messages that show values. */
    toJSON() {
      return this.live ? `#<buffer ${this.name}>` : "#<killed buffer>";
    }
  }
  /**
   * A keymap, as Emacs's keymaps are values: bound in a keymap, it is a
   * prefix map, and a variable or text property can hold one.
   */
  class Keymap {
    constructor(id) {
      Object.defineProperty(this, "__e8KeymapId", { value: id });
      Object.freeze(this);
    }
    toJSON() {
      return "#<keymap>";
    }
  }
  // A script object's identity as an editor value, the same each time, kept
  // beside the object rather than on it.
  const objectIds = new WeakMap();
  let nextObjectId = 1;
  globalThis.__e8ObjectId = (object) => {
    let id = objectIds.get(object);
    if (id === undefined) {
      id = nextObjectId++;
      objectIds.set(object, id);
    }
    return id;
  };
  const keymaps = new Map();
  globalThis.__e8Keymap = (id) => {
    let k = keymaps.get(id);
    if (k === undefined) {
      k = new Keymap(id);
      keymaps.set(id, k);
    }
    return k;
  };
  /**
   * A char-table, as Emacs's char-tables are values: a value for each
   * character, such as a case table's lower cases.
   */
  class CharTable {
    constructor(id) {
      Object.defineProperty(this, "__e8CharTableId", { value: id });
      Object.freeze(this);
    }
    toJSON() {
      return "#<char-table>";
    }
  }
  const charTables = new Map();
  globalThis.__e8CharTable = (id) => {
    let t = charTables.get(id);
    if (t === undefined) {
      t = new CharTable(id);
      charTables.set(id, t);
    }
    return t;
  };
  /** A tree-sitter parser of a buffer, as Emacs's treesit-parser objects: the same object each time. */
  class TreesitParser {
    constructor(raw) {
      Object.defineProperty(this, "__e8TreesitParser", { value: Object.freeze(raw) });
      Object.freeze(this);
    }
    toJSON() {
      return "#<treesit-parser>";
    }
  }
  /** A node of a syntax tree, as Emacs's treesit-node objects; treesitNodeEq compares them. */
  class TreesitNode {
    constructor(raw) {
      Object.defineProperty(this, "__e8TreesitNode", { value: Object.freeze(raw) });
      Object.freeze(this);
    }
    toJSON() {
      return `#<treesit-node ${native.treesitPrimitive("treesit-node-type", this)}>`;
    }
  }
  const treesitParsers = new Map();
  globalThis.__e8Treesit = (kind, raw) => {
    if (kind === "node") return new TreesitNode(raw);
    const key = raw.join(":");
    let p = treesitParsers.get(key);
    if (p === undefined) {
      p = new TreesitParser(raw);
      treesitParsers.set(key, p);
    }
    return p;
  };
  /** Runs a tree-sitter primitive by its Lisp name; nil comes back as undefined. */
  const treesit = (name, ...args) => native.treesitPrimitive(name, ...args.map((a) => (a === undefined ? null : a))) ?? undefined;
  const keymapArg = (k) => (k instanceof Keymap ? k : symbolName(k));
  // A binding: a command, a keymap, nil, or keys, as a string or vector binding in Emacs.
  const bindingArg = (b) => (b === null || b === undefined ? null : b instanceof Keymap ? b : Array.isArray(b) ? b.map(String) : symbolName(b));
  // A transient map made from the same bindings is made once.
  const transientMaps = new Map();
  // What frame-or-buffer-changed-p saw last.
  let frameOrBufferState;
  globalThis.__e8Buffer = (id) => {
    let b = buffers.get(id);
    if (b === undefined) {
      b = new Buffer(id);
      buffers.set(id, b);
    }
    return b;
  };
  /**
   * A string with text properties, as Emacs's propertized strings: its
   * `string`, and `properties` as [start, end, {name: value}] runs counted
   * in characters. It reads as its string wherever a string is wanted.
   */
  class PropertizedString {
    constructor(string, properties = []) {
      Object.defineProperty(this, "__e8Text", { value: true, enumerable: false });
      this.string = String(string);
      this.properties = properties;
      Object.freeze(this);
    }
    toString() {
      return this.string;
    }
  }
  globalThis.__e8Text = (string, runs) => new PropertizedString(string, runs);

  /**
   * A marker as an object, as Emacs's markers are: once nothing refers to
   * it, the collector frees it and the editor forgets it, as Emacs's GC
   * unchains unreferenced markers, so code need not delete markers itself.
   */
  const markersFreed = new FinalizationRegistry((id) => native.deleteMarker(id));
  /**
   * A frame's windows as they were, to put back, as Emacs's window
   * configurations: the editor keeps it until nothing refers to it.
   */
  const configurationsFreed = new FinalizationRegistry((id) => native.freeWindowConfiguration(id));
  class WindowConfiguration {
    constructor(id) {
      Object.defineProperty(this, "__e8WindowConfiguration", { value: id });
      configurationsFreed.register(this, id);
      Object.freeze(this);
    }
  }
  class Marker {
    constructor(id) {
      Object.defineProperty(this, "__e8MarkerId", { value: id });
      // What deleting it early unregisters it with: not the marker itself,
      // which the registry would keep alive.
      Object.defineProperty(this, "__e8MarkerToken", { value: {} });
      Object.freeze(this);
    }
    get id() {
      return this.__e8MarkerId;
    }
    /** Where it is, or undefined if it points nowhere. */
    get position() {
      return native.markerPosition(this.__e8MarkerId) ?? undefined;
    }
    valueOf() {
      return this.position;
    }
  }
  // A script's function that calls an editor function: once collected,
  // the engine can forget the editor function, if it gave out no other.
  const functionsFreed = new FinalizationRegistry((id) => native.forgetFunction(id));
  globalThis.__e8TrackFunction = (f, id) => functionsFreed.register(f, id);
  // Markers the editor holds in variables and properties: kept from the
  // registry that deletes collected ones, and the same object each time.
  const markersKept = new Map();
  globalThis.__e8KeepMarker = (m) => {
    if (!markersKept.has(m.id)) {
      markersFreed.unregister(m.__e8MarkerToken);
      markersKept.set(m.id, m);
    }
  };
  globalThis.__e8Marker = (id) => {
    let m = markersKept.get(id);
    if (m === undefined) {
      m = new Marker(id);
      markersKept.set(id, m);
    }
    return m;
  };
  /**
   * A font spec, entity or object, as Emacs's font values: its kind and
   * its properties, which fontPut changes in place.
   */
  class Font {
    constructor(kind, plist) {
      Object.defineProperty(this, "__e8FontKind", { value: kind });
      Object.defineProperty(this, "__e8FontPlist", { value: plist });
    }
    toJSON() {
      return `#<${this.__e8FontKind}>`;
    }
  }
  globalThis.__e8Font = (kind, plist) => new Font(kind, plist);
  // The loop checks' countdown to calling e8.maybeQuit (strip.rs).
  globalThis.__e8Quit = 1024;
  /** A marker's id, from a marker or the number a process mark is. */
  const markerId = (m) => (m instanceof Marker ? m.id : m);

  /** A symbol's name, or a string as the name it is, as functions that take a symbol accept either. */
  const symbolName = (s) => (typeof s === "symbol" ? s.description : String(s));

  /** Makes the buffer with an id current again, if it is still live, as save-current-buffer does. */
  const backTo = (id) => {
    const name = native.bufferNameOf(id);
    if (name !== null && name !== undefined) native.setCurrentBuffer(name);
  };
  /** Forgets a killed buffer's object, once packages have loaded and hooks can be added. */
  const forgetBuffer = () => buffers.delete(native.bufferIdOf());

  /** Runs a coding or charset primitive by its Lisp name. */
  const coding = (name, ...args) => native.codingPrimitive(name, ...args);

  /** A buffer's name from a name or a buffer object, as functions that take a buffer accept either. */
  const nameOf = (b) => (b instanceof Buffer ? (b.live ? b.name : e8.signal("error", "Selecting deleted buffer")) : String(b));

  const isPromise = (v) => v !== null && typeof v === "object" && typeof v.then === "function";

  /**
   * Runs `body`, then `cleanup`, even if `body` throws, as unwind-protect.
   * If `body` returns a promise, as an async function waiting on a prompt
   * does, `cleanup` runs once it settles: what `body` bound stays bound
   * while it waits, as a Lisp let stays bound in a recursive edit.
   */
  function unwindProtect(body, cleanup) {
    let result;
    try {
      result = body();
    } catch (e) {
      cleanup();
      throw e;
    }
    if (!isPromise(result)) {
      cleanup();
      return result;
    }
    return result.then(
      (value) => {
        cleanup();
        return value;
      },
      (e) => {
        cleanup();
        throw e;
      },
    );
  }

  /**
   * Moves over the characters in `set`, as skip-chars-forward reads it: a
   * leading ^ for those not in it, a-z for ranges, \\ quoting. Returns how
   * far it went.
   */
  function skipChars(set, limit, dir) {
    const not = set.startsWith("^");
    const body = not ? set.slice(1) : set;
    const singles = new Set();
    const ranges = [];
    for (let i = 0; i < body.length; i++) {
      let c = body[i];
      if (c === "\\" && i + 1 < body.length) c = body[++i];
      if (body[i + 1] === "-" && i + 2 < body.length) {
        ranges.push([c, body[i + 2]]);
        i += 2;
      } else {
        singles.add(c);
      }
    }
    const inSet = (c) => singles.has(c) || ranges.some(([a, b]) => c >= a && c <= b);
    const start = native.point();
    let p = start;
    if (dir > 0) {
      while (p < limit && inSet(native.bufferText(p, p + 1)) !== not) p++;
    } else {
      while (p > limit && inSet(native.bufferText(p - 1, p)) !== not) p--;
    }
    native.gotoChar(p);
    return p - start;
  }

  /** Emacs regexps translated to JavaScript, by source and case folding. */
  const regexps = new Map();
  const CLASSES = {
    alnum: "\\p{L}\\p{N}", alpha: "\\p{L}", digit: "0-9", xdigit: "0-9A-Fa-f", space: "\\s", blank: " \\t",
    upper: "\\p{Lu}", lower: "\\p{Ll}", word: "\\p{L}\\p{N}", punct: "\\p{P}\\p{S}", cntrl: "\\x00-\\x1f",
    graph: "\\p{L}\\p{N}\\p{P}\\p{S}", print: "\\p{L}\\p{N}\\p{P}\\p{S} ", ascii: "\\x00-\\x7f", nonascii: "\\u0080-\\u{10ffff}",
  };
  /** An Emacs regexp as JavaScript source: groups and alternatives backslashed, brackets with literal backslashes. */
  function translateEmacsRegexp(re) {
    let out = "";
    for (let i = 0; i < re.length; i++) {
      const c = re[i];
      if (c === "\\" && i + 1 < re.length) {
        const n = re[++i];
        if (n === "(") {
          // \(?: shy groups, and \(?N: numbered ones as plain groups.
          const m = /^\?(\d*):/.exec(re.slice(i + 1));
          out += m ? (m[1] === "" ? "(?:" : "(") : "(";
          if (m) i += m[0].length;
        } else if (")|{}".includes(n)) out += n;
        else if (n === "'") out += "(?![\\s\\S])";
        else if (n === "`") out += "(?<![\\s\\S])";
        else if (n === "w") out += "[\\p{L}\\p{N}]";
        else if (n === "W") out += "[^\\p{L}\\p{N}]";
        else if (n === "b" || n === "B") out += "\\" + n;
        else if (n === "<") out += "(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])";
        else if (n === ">") out += "(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}])";
        else if (n === "_" && (re[i + 1] === "<" || re[i + 1] === ">")) {
          out += re[++i] === "<" ? "(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])" : "(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])";
        } else if (n === "s" || n === "S") {
          // Syntax classes, as the standard table has them.
          const k = re[++i];
          const set = k === "-" || k === " " ? "\\s" : k === "w" ? "\\p{L}\\p{N}" : k === "_" ? "_\\-+*/&|<>=" : k === "." ? "\\p{P}" : "\\s";
          out += n === "s" ? `[${set}]` : `[^${set}]`;
        } else if (/[1-9]/.test(n)) out += "\\" + n;
        else out += /[A-Za-z0-9]/.test(n) ? n : "\\" + n;
      } else if ("(){}|/".includes(c)) {
        out += "\\" + c;
      } else if (c === "[") {
        // A bracket expression: ] first is literal, backslash is literal, [:class:] named.
        let j = i + 1;
        let body = "";
        if (re[j] === "^") {
          body += "^";
          j++;
        }
        if (re[j] === "]") {
          body += "\\]";
          j++;
        }
        while (j < re.length && re[j] !== "]") {
          const cls = /^\[:(\w+):\]/.exec(re.slice(j));
          if (cls) {
            body += CLASSES[cls[1]] ?? "";
            j += cls[0].length;
          } else {
            body += "\\[]".includes(re[j]) ? "\\" + re[j] : re[j];
            j++;
          }
        }
        out += `[${body}]`;
        i = j;
      } else {
        out += c;
      }
    }
    return out;
  }

  /** Functions named for code to call by name, as Emacs's defun makes them, apart from commands. */
  const functions = new Map();

  globalThis.e8 = Object.freeze({
    ...api,
    defineCommand(definition) {
      if (typeof definition !== "object" || definition === null) {
        throw new TypeError("defineCommand takes an object: { name, doc, params, run }");
      }
      const { name, doc = "", params = [], run, shiftSelect = false } = definition;
      if (typeof name !== "string" || name === "") {
        throw new TypeError("A command needs a name");
      }
      if (typeof run !== "function") {
        throw new TypeError(`Command ${name} needs a run function`);
      }
      functions.delete(name);
      native.defineCommand(
        name,
        String(doc),
        params.map((p) => ({
          name: String(p.name),
          kind: p.kind ?? "string",
          prompt: typeof p.prompt === "function" ? p.prompt : p.prompt ?? `${p.name}: `,
          initial: p.initial ?? null,
          collection: typeof p.collection === "function" ? (...args) => [...p.collection(...args)].map(String) : null,
          requireMatch: Boolean(p.requireMatch),
          history: p.history === undefined ? null : String(p.history),
        })),
        run,
        Boolean(shiftSelect),
      );
      return name;
    },
    bindKey: (keys, command, keymap) => native.bindKey(String(keys), bindingArg(command), keymap === undefined ? native.currentGlobalMap() : keymapArg(keymap)),
    defineKey: (keymap, keys, binding) => native.bindKey(String(keys), bindingArg(binding), keymapArg(keymap)),
    keymapUnset: (keymap, keys, remove = false) => native.keymapUnset(keymapArg(keymap), String(keys), Boolean(remove)),
    makeSparseKeymap: (parent) => native.makeSparseKeymap(parent === undefined || parent === null ? null : keymapArg(parent)),
    keymapp: (value) => value instanceof Keymap,
    keymapParent: (keymap) => native.keymapParent(keymapArg(keymap)),
    setKeymapParent: (keymap, parent) => native.setKeymapParent(keymapArg(keymap), parent === undefined || parent === null ? null : keymapArg(parent)),
    lookupKey: (keymap, keys) => native.lookupKey(keymapArg(keymap), String(keys)),
    keymapBindings: (keymap) => native.keymapBindings(keymapArg(keymap)),
    message: (text, { log = true } = {}) => native.message(String(text), Boolean(log)),
    insert: (text) => (text instanceof PropertizedString ? native.insertText(text) : native.insert(String(text))),
    PropertizedString,
    propertize(string, properties = {}) {
      const s = String(string);
      const n = [...s].length;
      return new PropertizedString(s, n > 0 && Object.keys(properties).length > 0 ? [[0, n, { ...properties }]] : []);
    },
    // As Emacs's concat: the strings one after another, keeping their text properties.
    concat(...parts) {
      let string = "";
      let at = 0;
      const runs = [];
      for (const part of parts) {
        const s = String(part ?? "");
        if (part instanceof PropertizedString) {
          for (const [start, end, props] of part.properties) runs.push([start + at, end + at, props]);
        }
        string += s;
        at += [...s].length;
      }
      return new PropertizedString(string, runs);
    },
    bufferSubstringNoProperties: (start, end) => native.bufferText(start, end),
    deleteAndExtractRegion(start, end) {
      const text = native.bufferSubstring(start, end);
      native.deleteRegion(start, end);
      return text;
    },
    insertBufferSubstring(buffer, start, end) {
      const text = e8.withCurrentBuffer(buffer, () => native.bufferSubstring(start ?? native.pointMin(), end ?? native.pointMax()));
      native.insertText(text);
    },
    insertBufferSubstringNoProperties(buffer, start, end) {
      native.insert(e8.withCurrentBuffer(buffer, () => native.bufferText(start ?? native.pointMin(), end ?? native.pointMax())));
    },
    // As compare-buffer-substrings: -N or N if the first is less or greater
    // after N - 1 characters, 0 if they match; case is folded as the
    // current buffer's case-fold-search says.
    compareBufferSubstrings(buffer1, start1, end1, buffer2, start2, end2) {
      const chars = (buffer, start, end) => {
        const get = () => [...native.bufferText(start ?? native.pointMin(), end ?? native.pointMax())];
        return buffer === null || buffer === undefined ? get() : e8.withCurrentBuffer(buffer, get);
      };
      const [a, b] = [chars(buffer1, start1, end1), chars(buffer2, start2, end2)];
      const fold = native.variable("case-fold-search");
      const canon = fold !== false && fold !== null && fold !== undefined ? (c) => native.downcase(c) : (c) => c;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const [c1, c2] = [canon(a[i]).codePointAt(0), canon(b[i]).codePointAt(0)];
        if (c1 !== c2) return c1 < c2 ? -(i + 1) : i + 1;
      }
      return a.length < b.length ? -(n + 1) : a.length > b.length ? n + 1 : 0;
    },
    bufferNarrowedP: () => native.pointMin() > 0 || native.pointMax() < native.bufferSize(),
    // As save-restriction: the buffer's narrowing put back after `fn`,
    // following edits to its edges, or the buffer widened if it was not narrowed.
    saveRestriction(fn) {
      const id = native.recordRestriction();
      return unwindProtect(fn, () => native.unbind(id));
    },
    bufferLocalValue: (name, buffer) => e8.withCurrentBuffer(buffer, () => native.variable(String(name)) ?? undefined),
    bufferUndoList: (buffer) =>
      buffer === undefined ? native.bufferUndoList() : e8.withCurrentBuffer(buffer, () => native.bufferUndoList()),
    makeIndirectBuffer: (base, name, clone = false) =>
      globalThis.__e8Buffer(native.makeIndirectBuffer(nameOf(base), String(name), Boolean(clone))),
    bufferBaseBuffer(buffer) {
      const id = native.bufferBaseBuffer(buffer === undefined ? native.bufferName() : nameOf(buffer));
      return id === null || id === undefined ? undefined : globalThis.__e8Buffer(id);
    },
    codingSystemP: (cs) => typeof cs === "string" && coding("coding-system-p", cs),
    checkCodingSystem: (cs) => (cs === null || cs === undefined ? undefined : coding("check-coding-system", String(cs))),
    codingSystemList: (baseOnly = false) => coding("coding-system-list", Boolean(baseOnly)),
    codingSystemAliases: (cs) => coding("coding-system-aliases", String(cs)),
    codingSystemBase: (cs) => coding("coding-system-base", String(cs)),
    setCodingSystemPriority: (...codings) => coding("set-coding-system-priority", ...codings.map(String)),
    codingSystemPriorityList: (highestp = false) => coding("coding-system-priority-list", Boolean(highestp)),
    codingSystemType: (cs) => coding("coding-system-type", String(cs)),
    codingSystemEolType: (cs) => coding("coding-system-eol-type", String(cs)),
    codingSystemChangeEolConversion: (cs, eol) => coding("coding-system-change-eol-conversion", String(cs), eol ?? null),
    codingSystemChangeTextConversion: (eolCs, textCs) => coding("coding-system-change-text-conversion", String(eolCs), String(textCs)),
    codingSystemGet: (cs, prop) => coding("coding-system-get", String(cs), String(prop)) ?? undefined,
    codingSystemMnemonic: (cs) => coding("coding-system-get", String(cs), "mnemonic"),
    encodeCodingString: (string, cs) => coding("encode-coding-string", String(string), String(cs)),
    decodeCodingString: (string, cs) => coding("decode-coding-string", String(string), String(cs)),
    encodeCodingRegion: (start, end, cs) => coding("encode-coding-region", start, end, String(cs)),
    decodeCodingRegion: (start, end, cs) => coding("decode-coding-region", start, end, String(cs)),
    detectCodingString: (string, highest = false) => coding("detect-coding-string", String(string), Boolean(highest)),
    detectCodingRegion: (start, end, highest = false) => coding("detect-coding-region", start, end, Boolean(highest)),
    findCodingSystemsString: (string) => coding("find-coding-systems-string", String(string)),
    findCodingSystemsRegion: (start, end) => coding("find-coding-systems-region", start, end),
    unencodableCharPosition: (start, end, cs, count, string) =>
      coding("unencodable-char-position", start, end, String(cs), count ?? null, string === undefined ? null : String(string)) ?? undefined,
    checkCodingSystemsRegion: (start, end, codings) =>
      coding("check-coding-systems-region", start, end, [...codings].map(String)) ?? undefined,
    charsetp: (charset) => typeof charset === "string" && coding("charsetp", charset),
    charsetList: () => coding("charset-list"),
    charsetPriorityList: (highestOnly = false) => coding("charset-priority-list", Boolean(highestOnly)),
    charCharset: (ch, restriction) => coding("char-charset", String(ch), restriction === undefined ? null : [...restriction].map(String)) ?? undefined,
    encodeChar: (ch, charset) => coding("encode-char", String(ch), String(charset)) ?? undefined,
    decodeChar: (charset, code) => coding("decode-char", String(charset), code) ?? undefined,
    bufferEnableUndo: (buffer) =>
      buffer === undefined ? native.setUndoEnabled(true) : e8.withCurrentBuffer(buffer, () => native.setUndoEnabled(true)),
    bufferDisableUndo: (buffer) =>
      buffer === undefined ? native.setUndoEnabled(false) : e8.withCurrentBuffer(buffer, () => native.setUndoEnabled(false)),
    insertBeforeMarkers: (text) => native.insertBeforeMarkers(text instanceof PropertizedString ? text : String(text)),
    insertAndInherit: (text) => native.insertAndInherit(text instanceof PropertizedString ? text : String(text)),
    moveToColumn: (column) => native.moveToColumn(Math.max(0, Math.floor(Number(column)))),
    // Omitted arguments must not reach the native function as undefined.
    bufferText: (start, end) =>
      end === undefined
        ? start === undefined ? native.bufferText() : native.bufferText(start)
        : native.bufferText(start ?? 0, end),
    bufferName: (buffer) => (buffer === undefined ? native.bufferName() : e8.getBuffer(buffer)?.name),
    currentBuffer: () => globalThis.__e8Buffer(native.bufferIdOf()),
    getBuffer(buffer) {
      if (buffer instanceof Buffer) return buffer.live ? buffer : undefined;
      const id = native.bufferIdOf(String(buffer));
      return id === null || id === undefined ? undefined : globalThis.__e8Buffer(id);
    },
    bufferLiveP: (buffer) => buffer instanceof Buffer && buffer.live,
    prefixNumericValue: (arg = native.prefixArg()) =>
      arg === null ? 1 : arg === "-" ? -1 : Array.isArray(arg) ? arg[0] : arg,
    setKillRingYankPointer: (index) => native.setKillRingYankPointer(Math.max(0, Math.floor(index))),
    currentKill: (n = 0, { properties = false } = {}) => (properties ? native.currentKillText(n) : native.currentKill(n)),
    insertForYank: (text) => native.insertForYank(text instanceof PropertizedString ? text : String(text)),
    setLastCommand: (name) => native.setLastCommand(name === null || name === undefined ? null : String(name)),
    callLastKbdMacro: (count = 1) => native.callLastKbdMacro(count),
    defineVariable({ name, doc = "", value = null, local = false }) {
      native.defineVariable(String(name), String(doc), value, Boolean(local));
    },
    defineHook: (name, doc = "") => native.defineHook(String(name), String(doc)),
    addHook(hook, run, { local = false, depth, append = false } = {}) {
      if (typeof run !== "function") throw new TypeError("addHook takes a function");
      native.addHook(String(hook), run, Number(depth ?? (append ? 90 : 0)), Boolean(local));
    },
    removeHook(hook, run, { local = false } = {}) {
      if (typeof run === "function") native.removeHook(String(hook), run, Boolean(local));
    },
    runHooks: (hook, ...args) => native.runHooks(String(hook), args),
    runHookWithArgsUntilSuccess: (hook, ...args) => native.runHookUntil(String(hook), args, true),
    runHookWithArgsUntilFailure: (hook, ...args) => native.runHookUntil(String(hook), args, false),
    defineKeymap: (name, parent = null) => native.defineKeymap(symbolName(name), parent === null ? null : symbolName(parent)),
    useLocalMap: (keymap) => native.useLocalMap(keymap === null || keymap === undefined ? null : keymapArg(keymap)),
    // Each waits for its answer and returns it, as Emacs's does (ADR 0053).
    yesOrNoP: (question) => native.ask("yes-or-no", String(question), []),
    yOrNP: (question) => native.ask("y-or-n", String(question), []),
    readAnswer: (question, answers) => native.ask("answer", String(question), answers.map(String)),
    readKey: (prompt) => native.readKeyEvent("key", String(prompt ?? ""), null),
    readEvent: (prompt, options) => native.readKeyEvent("event", String(prompt ?? ""), options?.seconds ?? null) ?? undefined,
    readChar: (prompt, options) => native.readKeyEvent("char", String(prompt ?? ""), options?.seconds ?? null) ?? undefined,
    readKeySequence: (prompt) => native.readKeyEvent("sequence", String(prompt ?? ""), null),
    sleepFor: (seconds) => native.sleepFor(Number(seconds)),
    sitFor(seconds) {
      // As subr.el's sit-for: input already waiting ends it at once, and
      // input that comes is put back to be read as a command.
      if (native.inputPendingP()) return false;
      if (seconds <= 0) return true;
      // In batch mode there is no input to wait for: it sleeps, as subr.el's does there.
      if (e8.variable("noninteractive") === true) {
        native.sleepFor(Number(seconds));
        return true;
      }
      const key = e8.readEvent(undefined, { seconds });
      if (key === undefined) return true;
      e8.unreadKeys(key);
      return false;
    },
    thisCommandKeys: () => native.thisCommandKeys().join(" "),
    thisCommandKeysVector: () => native.thisCommandKeys(),
    lossageSize: (size) => (size === undefined ? native.lossageSize() : native.lossageSize(size)),
    inputPendingP: () => native.inputPendingP() || undefined,
    readCharChoice: (prompt, chars) => native.ask("char", String(prompt), [...String(chars)]),
    completingRead: (prompt, collection, options = {}) =>
      native.read(options.kind ?? "string", String(prompt), {
        collection: options.kind || typeof collection === "function" ? undefined : [...collection].map(String),
        // A function of the input, as completion-table-dynamic makes a table.
        collectionFunction: typeof collection === "function" ? (input) => [...collection(input)].map(String) : undefined,
        category: options.category,
        requireMatch: Boolean(options.requireMatch),
        initial: options.initial,
        default: options.default,
        history: options.history,
      }),
    readFileName: (prompt, options = {}) =>
      native.read("file", String(prompt), {
        dir: options.dir,
        default: options.default,
        initial: options.initial,
        requireMatch: Boolean(options.mustMatch),
        history: options.history,
      }),
    readString: (prompt, options = {}) =>
      native.read("string", String(prompt), {
        initial: options.initial,
        default: options.default,
        history: options.history,
      }),
    completionAllSortedCompletions: (options = {}) => native.completionAllSortedCompletions(Boolean(options.atEnd)) ?? undefined,
    completionTryCompletion: (input, names) =>
      native.completionTryCompletion(String(input), names === undefined ? undefined : [...names].map(String)) ?? undefined,
    cacheAllSortedCompletions: (completions) => native.cacheAllSortedCompletions(completions.map(String)),
    composeLocalMap: (keymap) => native.composeLocalMap(keymapArg(keymap)),
    directoryFiles: (dir, { full, match, nosort, count } = {}) =>
      native.directoryFiles(String(dir), Boolean(full), match ?? null, Boolean(nosort), count ?? null),
    fileModes: (file, { nofollow } = {}) => native.fileModes(String(file), Boolean(nofollow)) ?? undefined,
    fileNameConcat: (...parts) => native.fileNameConcat(parts.filter((p) => p !== undefined && p !== null).map(String)),
    makeTempFile: (prefix, { dir, suffix, text } = {}) => native.makeTempFile(String(prefix), Boolean(dir), String(suffix ?? ""), text ?? null),
    findFileNameHandler: (file, operation) => native.findFileNameHandler(String(file), symbolName(operation)) ?? undefined,
    insertFileContents: (file, { visit, beg, end, replace } = {}) =>
      native.insertFileContents(String(file), { visit: Boolean(visit), beg: beg ?? undefined, end: end ?? undefined, replace: Boolean(replace) }),
    writeRegion: (start, end, file, { append, visit, quiet, mustbenew } = {}) =>
      native.writeRegion(start ?? null, end ?? null, String(file), {
        append: Boolean(append),
        visit: visit === undefined || visit === false ? null : visit,
        quiet: Boolean(quiet),
        mustbenew: Boolean(mustbenew),
      }),
    copyFile: (from, to, { okIfExists = false, keepTime = false } = {}) =>
      native.copyFile(String(from), String(to), Boolean(okIfExists), Boolean(keepTime)),
    copyDirectory: (from, to, { keepTime = false } = {}) => native.copyDirectory(String(from), String(to), Boolean(keepTime)),
    renameFile: (from, to, { okIfExists = false } = {}) => native.renameFile(String(from), String(to), Boolean(okIfExists)),
    deleteFile: (file, { trash = false } = {}) => native.deleteFile(String(file), Boolean(trash)),
    makeDirectory: (dir, { parents = false } = {}) => native.makeDirectory(String(dir), Boolean(parents)),
    deleteDirectory: (dir, { recursive = false, trash = false } = {}) =>
      native.deleteDirectory(String(dir), Boolean(recursive), Boolean(trash)),
    projectFiles: (root, { ignores = [] } = {}) => native.projectFiles(String(root), ignores.map(String)),
    stringMatch: (regexp, text, { caseFold = false, start = 0 } = {}) => native.stringMatch(String(regexp), String(text), Boolean(caseFold), start) ?? undefined,
    writeTextFile: (file, text, { mode } = {}) => native.writeTextFile(String(file), String(text), mode ?? undefined),
    fileNameDirectory: (file) => {
      const i = String(file).lastIndexOf("/");
      return i < 0 ? undefined : String(file).slice(0, i + 1);
    },
    fileNameNondirectory: (file) => String(file).slice(String(file).lastIndexOf("/") + 1),
    fileNameAsDirectory: (file) => (String(file) === "" ? "./" : String(file).endsWith("/") ? String(file) : `${file}/`),
    directoryFileName: (file) => (String(file).length > 1 ? String(file).replace(/\/+$/, "") || "/" : String(file)),
    frameSize: () => {
      const [columns, lines, maxMiniWindowLines] = native.frameSize();
      return { columns, lines, maxMiniWindowLines };
    },
    runWithTimer: (secs, repeat, fn) => native.runWithTimer(Number(secs), repeat ?? null, false, fn),
    runWithIdleTimer: (secs, repeat, fn) => native.runWithTimer(Number(secs), repeat ? 1 : null, true, fn),
    setVisitedFileName: (file, { alongWithFile = false } = {}) =>
      native.setVisitedFileName(file === null || file === undefined ? null : String(file), Boolean(alongWithFile)),
    expandFileName: (file, dir) => (dir === undefined || dir === null ? native.expandFileName(String(file)) : native.expandFileName(String(file), String(dir))),
    doAutoSave: ({ quiet = false } = {}) => native.doAutoSave(Boolean(quiet)),
    pushMark: (position, options = {}) => native.pushMark(position, Boolean(options.activate)),
    keepMarkActive: (fn) => {
      const changed = native.takeChanged();
      try {
        return fn();
      } finally {
        native.takeChanged();
        native.setChanged(changed);
      }
    },

    splitWindow: (window, side = "below", size) => native.splitWindow(window ?? null, side === "right", size ?? null),
    lastMouseEvent() {
      const event = native.lastMouseEvent();
      if (event === null || event === undefined) return undefined;
      const start = event.start && { window: event.start.window, position: event.start.position ?? undefined };
      return { window: event.window, position: event.position ?? undefined, start, tabBar: event.tabBar ?? undefined };
    },
    windowBuffer: (window) => native.windowBuffer(window ?? native.selectedWindow()) ?? undefined,
    makeFrame: (buffer) => native.makeFrame(buffer === undefined || buffer === null ? null : nameOf(buffer)),
    getBufferCreate(name) {
      native.getBufferCreate(nameOf(name));
      return e8.getBuffer(nameOf(name));
    },
    withCurrentBuffer: (name, fn) => {
      const id = native.recordCurrentBuffer();
      try {
        native.setCurrentBuffer(nameOf(name));
      } catch (e) {
        native.unbind(id);
        throw e;
      }
      return unwindProtect(fn, () => native.unbind(id));
    },
    setWindowBuffer: (window, buffer) => native.setWindowBuffer(window ?? native.selectedWindow(), nameOf(buffer)),
    windowSize: (window) => {
      const size = native.windowSize(window ?? native.selectedWindow());
      return size
        ? { width: size[0], height: size[1], totalWidth: size[2], totalHeight: size[3], fullWidth: size[4] === 1 }
        : undefined;
    },
    windowUseTime: (window) => native.windowUseTime(window ?? native.selectedWindow()) ?? undefined,
    resizeWindow: (window, delta, horizontal = false, apply = true) =>
      native.resizeWindow(window ?? null, delta, horizontal, apply),

    search(pattern, options = {}) {
      const { from, regexp = false, backward = false, bound, caseFold } = options;
      return native.search(String(pattern), from ?? null, Boolean(regexp), Boolean(backward), bound ?? null, caseFold ?? null) ?? undefined;
    },
    replaceMatch(replacement, options = {}) {
      const [start, end] = native.replaceMatch(String(replacement), Boolean(options.literal), Boolean(options.fixedCase));
      return { start, end };
    },
    setOverridingMap: (keymap) => native.setOverridingMap(keymap === null || keymap === undefined ? null : keymapArg(keymap)),
    overridingMap: () => native.overridingMap() ?? undefined,
    setKeymapDefault: (keymap, command) => native.setKeymapDefault(keymapArg(keymap), command ?? null),
    remapCommand: (keymap, from, to) => native.remapCommand(keymapArg(keymap), String(from), to === null ? null : String(to)),

    treesitLanguageAvailable: (language) => native.treesitLanguages().includes(String(language)),
    treesitLanguageAvailableP: (language) => treesit("treesit-language-available-p", String(language)),
    treesitAvailableP: () => true,
    treesitSetPrimaryLanguage: (language) => native.treesitSetLanguage(language === null || language === undefined ? null : String(language)),
    treesitSetFontLockRules: (language, rules) => treesit("treesit--set-font-lock-rules", String(language), rules.map(([query, override]) => [String(query), override ?? null])),
    TreesitParser,
    TreesitNode,
    treesitParserP: (x) => x instanceof TreesitParser,
    treesitNodeP: (x) => x instanceof TreesitNode,
    treesitParserCreate: (language, buffer, noReuse = false, tag) =>
      treesit("treesit-parser-create", String(language), buffer ?? null, Boolean(noReuse), tag ?? null),
    treesitParserDelete: (parser) => treesit("treesit-parser-delete", parser),
    treesitParserList: (buffer, language, tag) => treesit("treesit-parser-list", buffer ?? null, language ?? null, tag ?? null),
    treesitParserBuffer: (parser) => treesit("treesit-parser-buffer", parser),
    treesitParserLanguage: (parser) => treesit("treesit-parser-language", parser),
    treesitParserTag: (parser) => treesit("treesit-parser-tag", parser),
    treesitParserRootNode: (parser) => treesit("treesit-parser-root-node", parser),
    treesitNodeParser: (node) => treesit("treesit-node-parser", node),
    treesitNodeType: (node) => treesit("treesit-node-type", node),
    treesitNodeStart: (node) => treesit("treesit-node-start", node),
    treesitNodeEnd: (node) => treesit("treesit-node-end", node),
    treesitNodeString: (node) => treesit("treesit-node-string", node),
    treesitNodeParent: (node) => treesit("treesit-node-parent", node),
    treesitNodeChild: (node, n, named = false) => treesit("treesit-node-child", node, n, Boolean(named)),
    treesitNodeChildCount: (node, named = false) => treesit("treesit-node-child-count", node, Boolean(named)),
    treesitNodeChildByFieldName: (node, field) => treesit("treesit-node-child-by-field-name", node, String(field)),
    treesitNodeFieldNameForChild: (node, n) => treesit("treesit-node-field-name-for-child", node, n),
    treesitNodeNextSibling: (node, named = false) => treesit("treesit-node-next-sibling", node, Boolean(named)),
    treesitNodePrevSibling: (node, named = false) => treesit("treesit-node-prev-sibling", node, Boolean(named)),
    treesitNodeFirstChildForPos: (node, pos, named = false) => treesit("treesit-node-first-child-for-pos", node, pos, Boolean(named)),
    treesitNodeDescendantForRange: (node, beg, end, named = false) =>
      treesit("treesit-node-descendant-for-range", node, beg, end, Boolean(named)),
    treesitNodeCheck: (node, property) => treesit("treesit-node-check", node, String(property)),
    treesitNodeEq: (a, b) => (a === null || a === undefined || b === null || b === undefined ? a === b : treesit("treesit-node-eq", a, b)),
    treesitQueryCompile: (language, query) => treesit("treesit-query-compile", String(language), String(query)),
    treesitQueryCapture: (node, query, beg, end, nodeOnly = false, grouped = false) =>
      treesit("treesit-query-capture", node, String(query), beg ?? null, end ?? null, Boolean(nodeOnly), Boolean(grouped)),

    addFaceTextProperty: (start, end, face, { append = false } = {}) =>
      native.addFaceTextProperty(start, end, Array.isArray(face) ? face : String(face), Boolean(append)),
    getTextProperty: (pos, name) => native.textPropertiesAt(pos)[String(name)],
    nextPropertyChange: (pos, limit) => native.propertyChange("next", pos, null, limit ?? null) ?? undefined,
    previousPropertyChange: (pos, limit) => native.propertyChange("previous", pos, null, limit ?? null) ?? undefined,
    nextSinglePropertyChange: (pos, prop, limit) =>
      native.propertyChange("next-single", pos, String(prop), limit ?? null) ?? undefined,
    previousSinglePropertyChange: (pos, prop, limit) =>
      native.propertyChange("previous-single", pos, String(prop), limit ?? null) ?? undefined,
    nextCharPropertyChange: (pos, limit) => native.propertyChange("next-char", pos, null, limit ?? null),
    previousCharPropertyChange: (pos, limit) => native.propertyChange("previous-char", pos, null, limit ?? null),
    nextSingleCharPropertyChange: (pos, prop, limit) =>
      native.propertyChange("next-single-char", pos, String(prop), limit ?? null),
    previousSingleCharPropertyChange: (pos, prop, limit) =>
      native.propertyChange("previous-single-char", pos, String(prop), limit ?? null),
    nextOverlayChange: (pos) => native.propertyChange("next-overlay", pos, null, null),
    previousOverlayChange: (pos) => native.propertyChange("previous-overlay", pos, null, null),
    textPropertyAny: (start, end, prop, value) =>
      native.textPropertySearch(true, start, end, String(prop), value ?? null) ?? undefined,
    textPropertyNotAll: (start, end, prop, value) =>
      native.textPropertySearch(false, start, end, String(prop), value ?? null) ?? undefined,
    getPosProperty: (pos, prop) => native.getPosProperty(pos, String(prop)) ?? undefined,
    fieldBeginning: (pos, escapeFromEdge = false, limit) =>
      native.findField(pos ?? native.point(), Boolean(escapeFromEdge), limit ?? null, null)[0],
    fieldEnd: (pos, escapeFromEdge = false, limit) =>
      native.findField(pos ?? native.point(), Boolean(escapeFromEdge), null, limit ?? null)[1],
    fieldString(pos) {
      const [beg, end] = native.findField(pos ?? native.point(), false, null, null);
      return native.bufferSubstring(beg, end);
    },
    fieldStringNoProperties(pos) {
      const [beg, end] = native.findField(pos ?? native.point(), false, null, null);
      return native.bufferText(beg, end);
    },
    deleteField(pos) {
      const [beg, end] = native.findField(pos ?? native.point(), false, null, null);
      if (beg < end) native.deleteRegion(beg, end);
    },
    constrainToField(newPos, oldPos, escapeFromEdge = false, onlyInLine = false, inhibitCaptureProperty) {
      const moves = newPos === null || newPos === undefined;
      const capture = inhibitCaptureProperty === null || inhibitCaptureProperty === undefined ? null : String(inhibitCaptureProperty);
      const pos = native.constrainToField(moves ? native.point() : newPos, oldPos, Boolean(escapeFromEdge), Boolean(onlyInLine), capture);
      if (moves) native.gotoChar(pos);
      return pos;
    },
    makeOverlay(start, end, properties = {}, options = {}) {
      const id = native.makeOverlay(start, end, options.frontAdvance === true, options.rearAdvance === true);
      for (const [name, value] of Object.entries(properties)) native.overlayPut(id, name, value ?? null);
      return id;
    },
    letBind(bindings, fn) {
      // As let: a variable local in the current buffer is bound there, any
      // other in its default value; each is restored where it was bound,
      // by the editor's binding stack.
      const ids = [];
      return unwindProtect(() => {
        for (const [name, value] of Object.entries(bindings)) ids.push(native.specbind(name, value ?? null));
        return fn();
      }, () => {
        for (const id of ids.reverse()) native.unbind(id);
      });
    },
    emacsRegexp(regexp, { caseFold = false } = {}) {
      const key = `${caseFold ? "i" : "c"}${regexp}`;
      let re = regexps.get(key);
      if (re === undefined) {
        try {
          re = new RegExp(translateEmacsRegexp(String(regexp)), caseFold ? "imu" : "mu");
        } catch (e) {
          e8.signal("invalid-regexp", `Invalid regexp: ${e instanceof Error ? e.message : e}`, [String(regexp)]);
        }
        regexps.set(key, re);
      }
      re.lastIndex = 0;
      return re;
    },
    matchingLines: (regexp, { caseFold, start, end } = {}) => native.matchingLines(String(regexp), caseFold ?? undefined, start ?? undefined, end ?? undefined),
    lookingAt: (regexp, pos, { caseFold } = {}) => native.lookingAt(String(regexp), pos ?? undefined, caseFold ?? undefined),
    reSearchForward(regexp, { bound, noerror = false, caseFold } = {}) {
      if (bound !== undefined && bound !== null && bound < native.point()) e8.signal("error", "Invalid search bound (wrong side of point)");
      const m = e8.search(regexp, { regexp: true, bound, caseFold });
      if (m === undefined) {
        if (noerror) return undefined;
        e8.signal("search-failed", `Search failed: "${regexp}"`, [String(regexp)]);
      }
      native.gotoChar(m.end);
      return m.end;
    },
    reSearchBackward(regexp, { bound, noerror = false, caseFold } = {}) {
      if (bound !== undefined && bound !== null && bound > native.point()) e8.signal("error", "Invalid search bound (wrong side of point)");
      const m = e8.search(regexp, { regexp: true, backward: true, bound, caseFold });
      if (m === undefined) {
        if (noerror) return undefined;
        e8.signal("search-failed", `Search failed: "${regexp}"`, [String(regexp)]);
      }
      native.gotoChar(m.start);
      return m.start;
    },
    matchBeginning: (n = 0) => native.matchData()?.groups[n]?.[0] ?? undefined,
    matchEnd: (n = 0) => native.matchData()?.groups[n]?.[1] ?? undefined,
    matchString(n = 0, string) {
      const g = native.matchData()?.groups[n];
      if (!g) return undefined;
      return string === undefined ? native.bufferText(g[0], g[1]) : [...String(string)].slice(g[0], g[1]).join("");
    },
    signal(symbol, message, data = []) {
      const e = new Error(String(message));
      e.symbol = String(symbol);
      e.data = data;
      e.conditions = native.errorConditions(String(symbol));
      throw e;
    },
    userError: (message) => e8.signal("user-error", message),
    require(feature) {
      if (!native.require(String(feature))) {
        e8.signal("file-missing", `Cannot open load file: No such file or directory, ${feature}`, ["Cannot open load file", "No such file or directory", String(feature)]);
      }
      return String(feature);
    },
    load(feature) {
      // A module of its own each time, so its code runs anew.
      if (!native.require(`${feature}#${++loads}`)) {
        e8.signal("file-missing", `Cannot open load file: No such file or directory, ${feature}`, ["Cannot open load file", "No such file or directory", String(feature)]);
      }
      return String(feature);
    },
    usePackage(source, options = {}) {
      e8.require("use-package");
      return e8.funcall("use-package", String(source), options);
    },
    defineError: (symbol, parent = "error") => native.defineError(String(symbol), String(parent)),
    errorConditions: (e) =>
      e instanceof Error && Array.isArray(e.conditions) ? e.conditions : e instanceof Error && typeof e.symbol === "string" ? native.errorConditions(e.symbol) : ["error"],
    conditionCase(fn, handlers) {
      const handle = (e) => {
        // Engine errors are bugs to see, not conditions to handle, unless asked for by name.
        const conditions = e8.errorConditions(e);
        for (const c of conditions) {
          if (Object.prototype.hasOwnProperty.call(handlers, c)) {
            return handlers[c]({
              symbol: e?.symbol ?? "error",
              data: e?.data ?? [],
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }
        throw e;
      };
      let result;
      try {
        result = fn();
      } catch (e) {
        return handle(e);
      }
      return isPromise(result) ? result.then(undefined, handle) : result;
    },
    unwindProtect,
    ignoreErrors(fn) {
      return e8.conditionCase(fn, { error: () => undefined });
    },
    defun(name, fn) {
      if (typeof fn !== "function") throw new TypeError("defun takes a name and a function");
      name = symbolName(name);
      functions.set(name, fn);
      native.defun(name, fn);
      return name;
    },
    defalias(name, definition) {
      name = symbolName(name);
      if (typeof definition === "function") functions.set(name, definition);
      else functions.delete(name);
      native.defalias(name, typeof definition === "symbol" ? symbolName(definition) : definition);
      return name;
    },
    fmakunbound(name) {
      functions.delete(symbolName(name));
      native.fmakunbound(symbolName(name));
    },
    adviceAdd(symbol, how, fn, props) {
      if (typeof fn !== "function") throw new TypeError("adviceAdd takes a name, how, and a function");
      native.adviceAdd(symbolName(symbol), symbolName(how), fn, props?.name === undefined ? null : symbolName(props.name), props?.depth ?? null);
    },
    adviceRemove: (symbol, fn) => native.adviceRemove(symbolName(symbol), typeof fn === "function" ? fn : symbolName(fn)),
    adviceMemberP: (fn, symbol) => native.adviceMemberP(typeof fn === "function" ? fn : symbolName(fn), symbolName(symbol)),
    minibufferWindow: () => 0,
    formatModeLine: (format) => native.formatModeLine(format === undefined ? Symbol.for("mode-line-format") : format),
    fboundp: (name) => native.fboundp(symbolName(name)),
    intern: (name) => Symbol.for(String(name)),
    symbolName,
    put: (symbol, property, value) => native.put(symbolName(symbol), symbolName(property), value ?? null),
    get: (symbol, property) => native.get(symbolName(symbol), symbolName(property)),
    symbolFunction: (name) => functions.get(symbolName(name)) ?? native.symbolFunction(symbolName(name)),
    funcall(f, ...args) {
      if (typeof f === "function") return f(...args);
      // A script's own function is called directly; others, commands and
      // advised functions, through the editor, which gives objects back as themselves.
      const name = symbolName(f);
      const fn = functions.get(name);
      if (fn !== undefined && !native.advised(name)) return fn(...args);
      return native.funcall(name, args);
    },
    charAfter: (pos) => {
      const p = pos ?? native.point();
      return p >= native.pointMin() && p < native.pointMax() ? native.bufferText(p, p + 1) : undefined;
    },
    charBefore: (pos) => {
      const p = (pos ?? native.point()) - 1;
      return p >= native.pointMin() && p < native.pointMax() ? native.bufferText(p, p + 1) : undefined;
    },
    // At point, as Emacs's, a field's edge on the same line stops them, as
    // after a shell's prompt. Given a position, which Emacs's do not take,
    // and as posBol and posEol, they do not stop there.
    lineBeginningPosition: (pos) => {
      const bol = native.lineStart(native.lineOf(pos ?? native.point()));
      return pos === undefined ? native.constrainToField(bol, native.point(), false, true, undefined) : bol;
    },
    lineEndPosition: (pos) => {
      const eol = native.lineEnd(native.lineOf(pos ?? native.point()));
      return pos === undefined ? native.constrainToField(eol, native.point(), false, true, undefined) : eol;
    },
    // Emacs's own limit, MAX-COSTS, counts differently; past 2000
    // deletions and insertions the part that differs is replaced whole.
    replaceBufferContents: (source, maxSecs, maxCosts) =>
      native.replaceBufferContents(nameOf(source), Math.min(typeof maxCosts === "number" ? maxCosts : 2000, 2000)),
    transposeRegions: (start1, end1, start2, end2, leaveMarkers = false) =>
      native.transposeRegions(start1, end1, start2, end2, Boolean(leaveMarkers)),
    posBol: (pos) => native.lineStart(native.lineOf(pos ?? native.point())),
    posEol: (pos) => native.lineEnd(native.lineOf(pos ?? native.point())),
    currentIndentation: (pos) => {
      const tab = Number(native.variable("tab-width") ?? 8) || 8;
      let col = 0;
      for (const c of native.lineText(native.lineOf(pos ?? native.point()))) {
        if (c === " ") col++;
        else if (c === "\t") col += tab - (col % tab);
        else break;
      }
      return col;
    },
    indentTo(column) {
      const now = native.currentColumn();
      if (now >= column) return now;
      const tab = Number(native.variable("tab-width") ?? 8);
      let text = "";
      let col = now;
      if (native.variable("indent-tabs-mode") !== false && tab > 0) {
        while (Math.floor(col / tab) < Math.floor(column / tab)) {
          text += "\t";
          col = (Math.floor(col / tab) + 1) * tab;
        }
      }
      native.insert(text + " ".repeat(column - col));
      return column;
    },
    indentLineTo(column) {
      // As indent.el's: to the indentation's end, then only what must change.
      const start = native.lineStart(native.lineOf(native.point()));
      const ws = /^[ \t]*/.exec(native.lineText(native.lineOf(start)))[0].length;
      native.gotoChar(start + ws);
      const cur = native.currentColumn();
      const tab = Number(native.variable("tab-width") ?? 8) || 8;
      if (cur < column) {
        if (column - Math.floor(cur / tab) * tab >= tab) {
          let a = native.point();
          while (a > start && native.bufferText(a - 1, a) === " ") a--;
          native.deleteRegion(a, native.point());
          native.gotoChar(a);
        }
        e8.indentTo(column);
      } else if (cur > column) {
        native.gotoChar(start);
        native.moveToColumn(column);
        if (native.currentColumn() > column) {
          // Inside a tab: the indentation is made again.
          native.deleteRegion(start, start + ws);
          native.gotoChar(start);
          e8.indentTo(column);
        } else {
          native.deleteRegion(native.point(), start + ws);
        }
      }
    },
    skipCharsForward: (chars, limit) => skipChars(String(chars), limit ?? native.pointMax(), 1),
    skipCharsBackward: (chars, limit) => skipChars(String(chars), limit ?? native.pointMin(), -1),
    saveExcursion(fn) {
      const id = native.recordExcursion();
      return unwindProtect(fn, () => native.unbind(id));
    },
    makeProcess({ name, buffer, command, directory, env, filter, sentinel, stderr = true, connectionType, coding }) {
      if (!Array.isArray(command) || command.length === 0) throw new TypeError("makeProcess needs a command: [program, ...args]");
      const pairs = env === undefined ? undefined : Object.entries(env).map(([k, v]) => [String(k), String(v)]);
      // A pseudo-terminal unless pipes are asked for, as process-connection-type says.
      const type = connectionType ?? (native.variable("process-connection-type") === false || native.variable("process-connection-type") === null ? "pipe" : "pty");
      return native.makeProcess(
        String(name),
        buffer === undefined || buffer === null ? undefined : nameOf(buffer),
        command.map(String),
        {
          directory: directory ?? undefined,
          env: pairs,
          // A buffer for standard error, as make-process's :stderr, or whether it comes in as output.
          stderr: typeof stderr === "boolean" || stderr === undefined || stderr === null ? stderr !== false : nameOf(stderr),
          pty: type === "pty",
          coding: coding ?? undefined,
        },
        filter ?? undefined,
        sentinel ?? undefined,
      );
    },
    makeNetworkProcess({ name, buffer, host, service, family, server = false, filter, sentinel, coding }) {
      const local = family === "local";
      return native.makeNetworkProcess(
        {
          name: String(name),
          buffer: buffer === undefined || buffer === null ? undefined : nameOf(buffer),
          host: local ? undefined : String(host ?? "local"),
          service: String(service === true ? "t" : service),
          server: Boolean(server),
          coding: coding ?? undefined,
        },
        filter ?? undefined,
        sentinel ?? undefined,
      );
    },
    processLiveP: (name) => ["run", "open", "listen", "connect", "stop"].includes(native.processInfo(String(name))?.status),
    processCodingSystem: (name) => native.processPrimitive("process-coding-system", String(name)) ?? undefined,
    setProcessCodingSystem: (name, decoding, encoding) =>
      native.processPrimitive("set-process-coding-system", String(name), String(decoding ?? "undecided"), String(encoding ?? decoding ?? "undecided")),
    processTtyName: (name) => native.processPrimitive("process-tty-name", String(name)) ?? undefined,
    processType: (name) => native.processPrimitive("process-type", String(name)) ?? undefined,
    processContact: (name, key) =>
      key === undefined ? native.processPrimitive("process-contact", String(name)) : native.processPrimitive("process-contact", String(name), String(key)) ?? undefined,
    setProcessWindowSize: (name, height, width) => native.processPrimitive("set-process-window-size", String(name), height, width),
    processSendRegion: (name, start, end) => native.processSendString(String(name), native.bufferText(Math.min(start, end), Math.max(start, end))),
    quitProcess: (name, currentGroup = false) => native.processPrimitive("signal-process", String(name), "QUIT", Boolean(currentGroup)),
    stopProcess: (name, currentGroup = false) => native.processPrimitive("signal-process", String(name), "TSTP", Boolean(currentGroup)),
    continueProcess: (name, currentGroup = false) => native.processPrimitive("signal-process", String(name), "CONT", Boolean(currentGroup)),
    processStatus: (name) => native.processInfo(String(name))?.status,
    processExitStatus: (name) => native.processInfo(String(name))?.exitStatus ?? undefined,
    processBuffer: (name) => native.processInfo(String(name))?.buffer ?? undefined,
    processMark: (name) => native.processInfo(String(name))?.mark ?? undefined,
    processCommand: (name) => native.processInfo(String(name))?.command,
    processId: (name) => native.processInfo(String(name))?.pid ?? undefined,
    processQueryOnExitFlag: (name) => native.processInfo(String(name))?.queryOnExit ?? false,
    getBufferProcess: (buffer) => native.getBufferProcess(nameOf(buffer)) ?? undefined,
    interruptProcess: (name, currentGroup = false) => native.processPrimitive("signal-process", String(name), "INT", Boolean(currentGroup)),
    killProcess: (name, currentGroup = false) => native.processPrimitive("signal-process", String(name), "KILL", Boolean(currentGroup)),
    signalProcess: (name, signal) => native.processPrimitive("signal-process", String(name), signal, false),
    callProcess: (command, { directory, input } = {}) =>
      native.callProcess(command.map(String), directory ?? undefined, input === undefined ? undefined : String(input)),
    windowStart: (window) => native.windowStart(window ?? native.selectedWindow()),
    setWindowStart: (window, pos) => native.setWindowStart(window ?? native.selectedWindow(), pos),
    windowEnd: (window) => native.windowEnd(window ?? native.selectedWindow()),
    posVisibleInWindowP: (pos, window, partially) =>
      native.posVisibleInWindowP(pos ?? native.point(), window ?? native.selectedWindow(), Boolean(partially)) || undefined,
    posnAtPoint: (pos, window) => native.posnAtPoint(pos ?? native.point(), window ?? native.selectedWindow()),
    posnAtXY: (x, y, window) => native.posnAtXY(x, y, window ?? native.selectedWindow()),
    windowTextPixelSize: (window, from, to) => {
      const w = window ?? native.selectedWindow();
      return native.windowTextPixelSize(w, from ?? native.windowStart(w), to ?? native.windowEnd(w));
    },
    bufferTextPixelSize: (buffer) => native.bufferTextPixelSize(e8.getBuffer(buffer ?? native.bufferName())?.id ?? native.bufferIdOf()),
    stringPixelWidth(string) {
      if (String(string) === "") return 0;
      const temp = e8.getBufferCreate(e8.generateNewBufferName(" *string-pixel-width*"));
      return unwindProtect(
        () => e8.withCurrentBuffer(temp, () => {
          e8.insert(string);
          return e8.bufferTextPixelSize(temp)[0];
        }),
        () => e8.call("kill-buffer", temp),
      );
    },
    displayLineIsContinuedP: () => native.lineIsContinued(),
    // As Emacs's invisible-p: of a position, or of an invisible property's
    // value; true, "ellipsis" for text an ellipsis stands for, or false.
    invisibleP(posOrProp) {
      const how = typeof posOrProp === "number"
        ? native.invisibleValue(posOrProp >= native.pointMin() && posOrProp < native.pointMax() ? native.charProperty(posOrProp, "invisible") ?? null : null)
        : native.invisibleValue(posOrProp ?? null);
      return how === 2 ? "ellipsis" : how === 1;
    },
    // As Emacs's get-display-property: the value of PROP among the display
    // specs at POSITION, as `(height 2.0)` is PROP height's.
    getDisplayProperty(position, prop, object, properties) {
      const display = properties !== undefined ? properties.display
        : object !== undefined && typeof object === "object" ? undefined
        : native.charProperty(position, "display");
      if (!Array.isArray(display)) return undefined;
      const name = symbolName(prop);
      const specs = display.length > 0 && Array.isArray(display[0]) ? display : [display];
      for (const spec of specs) if (Array.isArray(spec) && symbolName(spec[0]) === name) return spec[1];
      return undefined;
    },
    currentBidiParagraphDirection: (buffer) =>
      buffer === undefined || buffer === null ? native.currentBidiParagraphDirection() : e8.withCurrentBuffer(buffer, () => native.currentBidiParagraphDirection()),
    beep: () => native.ding(),
    redrawDisplay: () => native.redisplay(),
    redrawFrame: () => native.redisplay(),
    // Bidirectional text, as xdisp.c's primitives and get-char-code-property
    // answer about it (ADR 0047).
    bidiResolvedLevels: (vpos) => (vpos === undefined || vpos === null ? native.bidiResolvedLevels() : native.bidiResolvedLevels(vpos)) ?? undefined,
    bidiFindOverriddenDirectionality(from, to, object, baseDir) {
      const rtl = baseDir !== undefined && baseDir !== null && symbolName(baseDir) === "right-to-left";
      const string = typeof object === "string" ? object : object instanceof PropertizedString ? object.string : undefined;
      const found = string !== undefined
        ? native.bidiFindOverriddenDirectionality(from, to, string, rtl)
        : object === undefined || object === null
          ? native.bidiFindOverriddenDirectionality(from, to, null, rtl)
          : e8.withCurrentBuffer(object, () => native.bidiFindOverriddenDirectionality(from, to, null, rtl));
      return found ?? undefined;
    },
    getCharCodeProperty: (char, property) => native.getCharCodeProperty(char, symbolName(property)) ?? undefined,
    // As frame-or-buffer-changed-p: whether the buffers, their names and
    // modified flags, or the frames changed since it was last asked.
    frameOrBufferChangedP() {
      const now = JSON.stringify([
        native.bufferList(),
        native.bufferList().map((b) => e8.withCurrentBuffer(b, () => native.bufferModified())),
        native.frameList(),
      ]);
      const changed = now !== frameOrBufferState;
      frameOrBufferState = now;
      return changed;
    },
    tabBarHeight: () => 0,
    toolBarHeight: () => 0,
    longLineOptimizationsP: () => false,
    windowMargins(window) {
      const [left, right] = native.windowMargins(window ?? native.selectedWindow());
      return [left === 0 ? undefined : left, right === 0 ? undefined : right];
    },
    setWindowMargins: (window, left, right) => native.setWindowMargins(window ?? native.selectedWindow(), left ?? 0, right ?? 0),
    windowFringes: () => (native.windowFringes() ? [8, 8, false, false] : [0, 0, false, false]),
    internalShowCursor: (window, show) => native.showWindowCursor(window ?? native.selectedWindow(), Boolean(show)),
    internalShowCursorP: (window) => native.windowCursorShown(window ?? native.selectedWindow()),
    defineFringeBitmap(bitmap, bits, height, width, align = "center") {
      const rows = [...bits];
      while (height !== undefined && rows.length < height) rows.push(0);
      native.defineFringeBitmap(symbolName(bitmap), rows.slice(0, height ?? rows.length), width ?? null, String(align));
      return symbolName(bitmap);
    },
    destroyFringeBitmap: (bitmap) => native.destroyFringeBitmap(symbolName(bitmap)),
    setFringeBitmapFace: (bitmap, face) => native.setFringeBitmapFace(symbolName(bitmap), face === undefined || face === null ? null : symbolName(face)),
    fringeBitmapP: (bitmap) => native.fringeBitmapP(symbolName(bitmap)),
    fringeBitmapsAtPos(pos, window) {
      const got = native.fringeBitmapsAtPos(pos ?? native.point(), window ?? native.selectedWindow());
      return got ? [got[0] || undefined, got[1] || undefined] : undefined;
    },
    windowPoint: (window) => native.windowPoint(window ?? native.selectedWindow()),
    setWindowPoint: (window, pos) => native.setWindowPoint(window ?? native.selectedWindow(), pos),
    switchToPrevBuffer: (window, buryOrKill) => {
      const w = window ?? native.selectedWindow();
      return (buryOrKill === undefined ? native.switchToPrevBuffer(w) : native.switchToPrevBuffer(w, String(buryOrKill))) ?? undefined;
    },
    switchToNextBuffer: (window) => native.switchToNextBuffer(window ?? native.selectedWindow()) ?? undefined,
    windowParameter: (window, name) => native.windowParameter(window ?? native.selectedWindow(), symbolName(name)),
    setWindowParameter: (window, name, value) => native.setWindowParameter(window ?? native.selectedWindow(), symbolName(name), value ?? null),
    windowParameters: (window) => {
      const w = window ?? native.selectedWindow();
      return Object.fromEntries(native.windowParameterNames(w).map((n) => [n, native.windowParameter(w, n)]));
    },
    windowDedicatedP: (window) => native.windowDedicatedP(window ?? native.selectedWindow()) ?? undefined,
    setWindowDedicatedP: (window, flag) => native.setWindowDedicatedP(window ?? native.selectedWindow(), flag ?? null),
    windowPrevBuffers: (window) => native.windowPrevBuffers(window ?? native.selectedWindow()),
    setWindowPrevBuffers: (window, buffers) => native.setWindowPrevBuffers(window ?? native.selectedWindow(), buffers.map(([b, s, p]) => [String(b), s, p])),
    windowNextBuffers: (window) => native.windowNextBuffers(window ?? native.selectedWindow()),
    setWindowNextBuffers: (window, buffers) => native.setWindowNextBuffers(window ?? native.selectedWindow(), buffers.map(String)),
    currentWindowConfiguration: () => new WindowConfiguration(native.currentWindowConfiguration()),
    setWindowConfiguration(configuration) {
      if (!(configuration instanceof WindowConfiguration)) throw new TypeError("setWindowConfiguration takes a window configuration");
      return native.setWindowConfiguration(configuration.__e8WindowConfiguration) || undefined;
    },
    windowConfigurationP: (value) => value instanceof WindowConfiguration,
    // As Emacs's save-window-excursion: the windows put back as they were, however fn ends.
    saveWindowExcursion(fn) {
      const configuration = e8.currentWindowConfiguration();
      return unwindProtect(fn, () => e8.setWindowConfiguration(configuration));
    },
    // As with-silent-modifications: changes to text properties are not
    // recorded for undo and leave the buffer as modified as it was, with
    // read-only text and the change hooks out of the way.
    withSilentModifications(fn) {
      const buffer = native.bufferIdOf();
      const state = native.beginSilentModifications();
      return unwindProtect(
        () => e8.letBind({ "inhibit-read-only": true, "inhibit-modification-hooks": true }, fn),
        () => native.endSilentModifications(buffer, state),
      );
    },
    atomicChangeGroup(fn) {
      const handle = native.prepareChangeGroup();
      try {
        const result = fn();
        native.acceptChangeGroup(handle);
        return result;
      } catch (e) {
        native.cancelChangeGroup(handle);
        throw e;
      }
    },
    makeSyntaxTable: (name, parent) => native.makeSyntaxTable(String(name), parent === undefined ? undefined : String(parent)),
    makeCharTable: (subtype, init) => native.makeCharTable(symbolName(subtype), init ?? null),
    charTableP: (value) => value instanceof CharTable && native.charTableP(value),
    charTableParent: (table) => native.charTableParent(table) ?? undefined,
    setCharTableParent: (table, parent) => native.setCharTableParent(table, parent ?? null),
    charTableExtraSlot: (table, n) => native.charTableExtraSlot(table, n) ?? undefined,
    charTableRange: (table, range) => native.charTableRange(table, range ?? null) ?? undefined,
    aref: (table, c) => native.charTableRange(table, c) ?? undefined,
    aset: (table, c, value) => native.setCharTableRange(table, c, value ?? null),
    mapCharTable: (fn, table) => {
      for (const [key, value] of native.mapCharTable(table)) fn(key, value);
    },
    copySequence: (value) => (value instanceof CharTable ? native.copyCharTable(value) : [...value]),
    caseTableP: (value) => value instanceof CharTable && native.caseTableP(value),
    // As subr.el's with-case-table: the case table back as it was however fn ends.
    withCaseTable(table, fn) {
      const old = native.currentCaseTable();
      const buffer = e8.currentBuffer();
      native.setCaseTable(table);
      return unwindProtect(fn, () => e8.withCurrentBuffer(buffer, () => native.setCaseTable(old)));
    },
    categoryTableP: (value) => value instanceof CharTable && native.categoryTableP(value),
    copyCategoryTable: (table) => native.copyCategoryTable(table ?? null),
    defineCategory: (category, doc, table) => native.defineCategory(String(category), String(doc), table ?? null),
    categoryDocstring: (category, table) => native.categoryDocstring(String(category), table ?? null) ?? undefined,
    getUnusedCategory: (table) => native.getUnusedCategory(table ?? null) ?? undefined,
    modifyCategoryEntry: (range, category, table, reset) => native.modifyCategoryEntry(range, String(category), table ?? null, Boolean(reset)),
    modifySyntaxEntry: (chars, descriptor, table) =>
      native.modifySyntaxEntry(String(chars), String(descriptor), table === undefined ? undefined : String(table)),
    charSyntax: (c) => (native.syntaxEntry(String(c)) ?? " ")[0],
    matchingParen: (c) => {
      const d = native.syntaxEntry(String(c)) ?? "";
      return "()".includes(d[0]) && d[1] !== undefined && d[1] !== " " ? d[1] : undefined;
    },
    scanLists: (from, count, depth) => native.scanLists(from, count, depth, false) ?? null,
    scanSexps: (from, count) => native.scanLists(from, count, 0, true) ?? null,
    forwardComment: (count = 1) => native.forwardComment(count),
    parsePartialSexp: (from, to) => {
      const st = native.parsePartialSexp(from, to);
      for (const k of ["innermostStart", "lastComplete", "inString", "inComment", "start"]) st[k] ??= null;
      return st;
    },
    syntaxPpss: (pos) => {
      const st = native.parsePartialSexp(undefined, pos ?? native.point());
      for (const k of ["innermostStart", "lastComplete", "inString", "inComment", "start"]) st[k] ??= null;
      return st;
    },
    skipSyntaxForward: (syntaxes, limit) => {
      const not = syntaxes.startsWith("^");
      const set = not ? syntaxes.slice(1) : syntaxes;
      const end = limit ?? native.pointMax();
      let p = native.point();
      const start = p;
      while (p < end) {
        const d = (native.syntaxEntry(native.bufferText(p, p + 1)) ?? " ")[0];
        if (set.includes(d) === not) break;
        p++;
      }
      native.gotoChar(p);
      return p - start;
    },
    skipSyntaxBackward: (syntaxes, limit) => {
      const not = syntaxes.startsWith("^");
      const set = not ? syntaxes.slice(1) : syntaxes;
      const end = limit ?? native.pointMin();
      let p = native.point();
      const start = p;
      while (p > end) {
        const d = (native.syntaxEntry(native.bufferText(p - 1, p)) ?? " ")[0];
        if (set.includes(d) === not) break;
        p--;
      }
      native.gotoChar(p);
      return start - p;
    },
    makeMarker(pos, { buffer, advances = false } = {}) {
      const id = native.makeMarker(pos ?? native.point(), buffer === undefined ? undefined : nameOf(buffer), Boolean(advances));
      const m = new Marker(id);
      markersFreed.register(m, id, m.__e8MarkerToken);
      return m;
    },
    Marker,
    deleteMarker(m) {
      if (m instanceof Marker) markersFreed.unregister(m.__e8MarkerToken);
      markersKept.delete(markerId(m));
      native.deleteMarker(markerId(m));
    },
    markerPosition: (m) => native.markerPosition(markerId(m)) ?? undefined,
    markerBuffer: (m) => native.markerBuffer(markerId(m)) ?? undefined,
    markerInsertionType: (m) => native.markerInsertionType(markerId(m)) ?? undefined,
    setMarkerInsertionType: (m, advances) => native.setMarkerInsertionType(markerId(m), Boolean(advances)),
    setMarker: (m, pos, buffer) =>
      native.setMarker(markerId(m), pos === null || pos === undefined ? undefined : pos, buffer === undefined ? undefined : nameOf(buffer)),
    overlayStart: (id) => native.overlayRange(id)?.[0],
    overlayEnd: (id) => native.overlayRange(id)?.[1],
    overlaysAt: (pos) => native.overlaysIn(pos, pos + 1).filter((id) => native.overlayRange(id)[0] <= pos && pos < native.overlayRange(id)[1]),
    // As Emacs's add-to-invisibility-spec: a spec of true becomes a list
    // that still hides text whose invisible property is true.
    addToInvisibilitySpec(name, { ellipsis = false } = {}) {
      const spec = native.variable("buffer-invisibility-spec");
      const entries = Array.isArray(spec) ? spec.filter((e) => (Array.isArray(e) ? e[0] : e) !== name) : [true];
      native.setVariable("buffer-invisibility-spec", [...entries, ellipsis ? [String(name), true] : String(name)]);
    },
    // As Emacs's remove-from-invisibility-spec: a spec of true becomes a
    // list, which hides only text whose invisible property is true.
    removeFromInvisibilitySpec(name) {
      const spec = native.variable("buffer-invisibility-spec");
      const entries = Array.isArray(spec) ? spec.filter((e) => (Array.isArray(e) ? e[0] : e) !== name) : [true];
      native.setVariable("buffer-invisibility-spec", entries);
    },
    defineFace({ name, doc = "", attributes = {}, dark = {}, light = {} }) {
      native.defineFace(String(name), String(doc), attributes, dark, light);
    },
    // Attributes as an object, or as Emacs's plist: [":weight", "bold", ...].
    setFaceAttribute: (name, attributes, { background = "both" } = {}) =>
      native.setFaceAttribute(
        String(name),
        Array.isArray(attributes) ? Object.fromEntries(attributes.flatMap((v, i) => (i % 2 === 0 ? [[String(v), attributes[i + 1]]] : []))) : attributes,
        String(background),
      ),
    faceAttributes: (name, { dark = true } = {}) => native.faceAttributes(String(name), Boolean(dark)),
    facep: (face) => native.faceInfo(String(face)) != null,
    makeFace: (name) => {
      native.makeFace(String(name));
      return String(name);
    },
    copyFace: (oldFace, newFace) => {
      native.copyFace(String(oldFace), String(newFace));
      return String(newFace);
    },
    maybeQuit() {
      globalThis.__e8Quit = 1024;
      native.maybeQuit();
    },
    withLocalQuit(fn) {
      // As with-local-quit: inhibit-quit off for the body, and a quit
      // deferred before it signalled once the body is done.
      return e8.letBind({ "inhibit-quit": false }, () => {
        e8.maybeQuit();
        return fn();
      });
    },
    fontSpec: (...plist) => native.fontSpec(plist),
    fontGet: (font, property) => native.fontGet(font, String(property)) ?? undefined,
    fontPut(font, property, value) {
      const changed = native.fontPut(font, String(property), value ?? null);
      font.__e8FontPlist.splice(0, Infinity, ...changed.__e8FontPlist);
      return value;
    },
    fontp: (object, kind) => object instanceof Font && (kind === undefined || object.__e8FontKind === kind),
    faceFont: (face) => native.faceFont(symbolName(face)) ?? undefined,
    fontAt: (pos) => native.fontAt(pos) ?? undefined,
    findFont: (spec) => native.listFonts(spec, 1)[0],
    fontInfo: (name) => native.fontInfo(String(name)) ?? undefined,
    queryFont: (font) => native.queryFont(font) ?? undefined,
    fontHasCharP: (font, c) => native.fontHasCharP(font, typeof c === "number" ? String.fromCodePoint(c) : String(c)),
    charDisplayableP: (c) => native.charDisplayableP(typeof c === "number" ? String.fromCodePoint(c) : String(c)),
    colorDefinedP: (color) => native.colorValues(String(color)) != null,
    colorSupportedP: (color) => native.colorValues(String(color)) != null,
    colorDistance(color1, color2) {
      const d = native.colorDistance(String(color1), String(color2));
      if (d == null) e8.signal("error", `Invalid color: ${native.colorValues(String(color1)) == null ? color1 : color2}`);
      return d;
    },
    colorGrayP: (color) => native.colorGrayP(String(color)) === true,

    // As Emacs's derived-mode-p: whether the buffer's major mode is one of
    // these or built on one.
    derivedModeP(...modes) {
      for (let mode = majorModes.get(native.variable("major-mode")); mode; mode = mode.parent === null ? undefined : majorModes.get(mode.parent)) {
        if (modes.includes(mode.name)) return true;
      }
      return false;
    },
    derivedModeAllParents(name = native.variable("major-mode")) {
      const out = [];
      for (let mode = majorModes.get(name); mode; mode = mode.parent === null ? undefined : majorModes.get(mode.parent)) out.push(mode.name);
      return out.length > 0 ? out : [String(name)];
    },

    defineMajorMode({ name, modeName, parent = null, doc = "", bindings, setup, syntax }) {
      if (parent !== null && !majorModes.has(parent)) {
        throw new TypeError(`Major mode ${name} is built on ${parent}, which is not a major mode`);
      }
      const keymap = `${name}-map`;
      native.defineKeymap(keymap, parent === null ? null : `${parent}-map`);
      bindAll(keymap, bindings);
      native.defineHook(`${name}-hook`, `Run after entering ${modeName} mode, after the hooks of the modes it is built on.`);
      // NAME-syntax-table, built on the parent mode's, as define-derived-mode makes it.
      const syntaxTable = `${name}-syntax-table`;
      native.makeSyntaxTable(syntaxTable, parent === null ? undefined : `${parent}-syntax-table`);
      for (const [chars, descriptor] of Object.entries(syntax ?? {})) native.modifySyntaxEntry(chars, String(descriptor), syntaxTable);
      majorModes.set(name, { name, parent, modeName: String(modeName), keymap, setup, syntaxTable });
      return e8.defineCommand({ name, doc, run: () => enterMajorMode(name) });
    },

    defineMinorMode({ name, lighter = "", doc = "", global = false, bindings, onChange }) {
      const pretty = prettyName(name);
      const keymap = `${name}-map`;
      native.defineVariable(
        name,
        `Whether ${pretty} mode is on${global ? "" : " in this buffer"}. Use the command ${name} to change it.`,
        false,
        !global,
      );
      native.defineKeymap(keymap, null);
      bindAll(keymap, bindings);
      native.defineHook(`${name}-hook`, `Run after ${pretty} mode is turned on or off.`);
      native.defineHook(`${name}-on-hook`, `Run after ${pretty} mode is turned on.`);
      native.defineHook(`${name}-off-hook`, `Run after ${pretty} mode is turned off.`);
      native.registerMinorMode(name, String(lighter), keymap, Boolean(global));
      return e8.defineCommand({
        name,
        doc:
          `${doc}\n\nRun from a key or M-x, it turns the mode on if it is off and off if it is on. ` +
          "A positive prefix argument turns it on and zero or a negative one turns it off. " +
          "Called from code without an argument, it turns the mode on.",
        run: () => {
          const arg = native.prefixArg();
          const interactive = native.calledInteractively();
          const enable =
            arg === null ? (interactive ? !isTrue(native.variable(name)) : true) : e8.prefixNumericValue(arg) > 0;
          native.setVariable(name, enable);
          if (onChange) onChange(enable);
          native.runHooks(`${name}-hook`);
          native.runHooks(`${name}-${enable ? "on" : "off"}-hook`);
          if (interactive) {
            native.message(`${pretty} mode ${enable ? "enabled" : "disabled"}${global ? "" : " in current buffer"}`);
          }
        },
      });
    },

    // Images, as image.c's primitives (ADR 0046). A spec is a list,
    // [Symbol.for("image"), Symbol.for(":type"), Symbol.for("png"), ...].
    imageSize(spec, pixels) {
      const [w, h] = native.imageSize(spec ?? null, Boolean(pixels));
      return [w, h];
    },
    imageMetadata: (spec) => native.imageMetadata(spec ?? null) ?? undefined,
    imageTransformsP() {
      const transforms = native.imageTransformsP();
      return transforms.length ? transforms.map((t) => Symbol.for(t)) : undefined;
    },
    initImageLibrary: (type) => native.initImageLibrary(symbolName(type)),
    displayImagesP: () => native.imagesShown(),

    setTransientMap(bindings) {
      if (bindings instanceof Keymap) return native.setTransientMap(bindings);
      const entries = Object.entries(bindings).map(([keys, command]) => [String(keys), String(command)]);
      const key = JSON.stringify(entries);
      let map = transientMaps.get(key);
      if (map === undefined) {
        map = native.makeSparseKeymap(null);
        for (const [keys, command] of entries) native.bindKey(keys, command, map);
        transientMaps.set(key, map);
      }
      native.setTransientMap(map);
    },
  });

  e8.addHook("kill-buffer-hook", forgetBuffer);

  globalThis.console = Object.freeze({
    log: (...items) => native.message(items.map(String).join(" ")),
  });
})();
