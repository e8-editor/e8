import { fillRegionAsParagraph } from "fill";
import { completingReadWithMetadata } from "minibuffer";
import { insertChar, truthy } from "subr";

// Choosing coding systems, after mule.el and mule-cmds.el: how the buffer
// is saved (C-x RET f), revisiting it in another (C-x RET r), giving the
// next command one (C-x RET c), and asking which one to save in when the
// buffer's own cannot write its text, as select-safe-coding-system does.

/**
 * `coding` with what it leaves unsaid, its line ends or its text
 * conversion, taken from `other`, as merge-coding-systems.
 */
export function mergeCodingSystems(coding: string, other: string | undefined): string {
  if (other === undefined || !e8.codingSystemP(other)) return coding;
  let merged = coding;
  if (Array.isArray(e8.codingSystemEolType(merged)) && !Array.isArray(e8.codingSystemEolType(other))) {
    merged = e8.codingSystemChangeEolConversion(merged, e8.codingSystemEolType(other) as number);
  }
  if (e8.codingSystemType(merged) === "undecided" && e8.codingSystemType(other) !== "undecided") {
    merged = e8.codingSystemChangeTextConversion(merged, other);
  }
  return merged;
}

/** The current buffer's coding system, if it has one. */
function bufferCoding(): string | undefined {
  const value = e8.variable("buffer-file-coding-system");
  return typeof value === "string" ? value : undefined;
}

/** Reads a coding system's name with completion, as read-coding-system; empty input gives undefined. */
export async function readCodingSystem(prompt: string, { asTyped = false } = {}): Promise<string | undefined> {
  const name = await e8.completingRead(prompt, e8.codingSystemList(), { history: "coding-system-history" });
  if (name === "") return undefined;
  // Checked either way; an alias stays as typed if asked, as a symbol read stays itself.
  const coding = e8.checkCodingSystem(name);
  return asTyped ? name : coding;
}

e8.defineVariable({ name: "coding-system-history", doc: "Coding systems answered in the minibuffer, newest first.", value: [] });

e8.defineCommand({
  name: "set-buffer-file-coding-system",
  doc:
    "Set how the buffer is written to its file: a coding system such as utf-8, iso-latin-1 or japanese-shift-jis, " +
    "with -unix, -dos or -mac for its line ends. Without them, the line ends stay as they are.\n\n" +
    "The buffer is then modified, to be saved that way.",
  params: [{ name: "coding", kind: "string", prompt: "Coding system for saved file (default nil): " }],
  run: (name: string) => {
    if (name === "") return;
    const coding = e8.checkCodingSystem(name) as string;
    const merged = mergeCodingSystems(coding, bufferCoding());
    e8.setVariable("buffer-file-coding-system", merged);
    // Chosen by hand, so saving does not try the defaults instead.
    const explicit = e8.variable("buffer-file-coding-system-explicit");
    e8.setVariable("buffer-file-coding-system-explicit", [Array.isArray(explicit) ? explicit[0] : null, merged]);
    e8.setBufferModified(true);
  },
});

e8.defineVariable({
  name: "buffer-file-coding-system-explicit",
  doc:
    "The coding systems given by hand for the buffer's file, as a pair: for reading it, as C-x RET c gave, and for writing it, " +
    "as C-x RET f gave. Saving tries only the one for writing, not the defaults, when it is set.",
  value: null,
  local: true,
});
e8.put("buffer-file-coding-system-explicit", "permanent-local", true);
// Visiting or reverting forgets the coding given for writing, keeping the
// one C-x RET c gave for reading, as after-insert-file-set-coding does.
e8.addHook("find-file-hook", () => {
  const read = e8.variable("coding-system-for-read");
  e8.setVariable("buffer-file-coding-system-explicit", [typeof read === "string" ? read : null, null]);
});

/**
 * Runs `fn` with `coding-system-for-read` and `-for-write` set to `coding`,
 * through the questions it asks, as a let around a command keeps its binding.
 */
function withCoding(variables: string[], coding: string, fn: () => void): void {
  const old = variables.map((v) => [v, e8.variable(v)] as const);
  for (const v of variables) e8.setVariable(v, coding);
  const restore = () => {
    for (const [v, value] of old) e8.setVariable(v, value ?? null);
  };
  try {
    fn();
  } finally {
    restore();
  }
}

e8.defineVariable({
  name: "default-file-name-coding-system",
  doc: "How file names are encoded: always UTF-8, as on macOS, since E8 keeps file names as Rust strings.",
  value: "utf-8-unix",
});

/**
 * Makes `coding` the default for new buffers and for processes, keeping
 * the processes' line ends, as Emacs's set-default-coding-systems.
 */
export function setDefaultCodingSystems(coding: string | null): void {
  if (coding !== null) e8.checkCodingSystem(coding);
  e8.setDefault("buffer-file-coding-system", coding);
  const process = e8.variable("default-process-coding-system");
  if (coding !== null && Array.isArray(process) && process.length === 2) {
    e8.setVariable(
      "default-process-coding-system",
      process.map((p) => e8.codingSystemChangeTextConversion(String(p), coding)),
    );
  }
}

e8.defineCommand({
  name: "prefer-coding-system",
  doc:
    "Make a coding system the one files are read in when their bytes fit it, and the default for new files and processes.\n\n" +
    "Its line ends, if named, become the default too.",
  run: async () => {
    const coding = await readCodingSystem("Prefer coding system: ", { asTyped: true });
    if (coding === undefined || !e8.codingSystemP(coding)) throw new Error(`Invalid coding system \`${coding ?? "nil"}'`);
    preferCodingSystem(coding, true);
  },
});

/**
 * Makes `coding` first among those detection tries and the default for
 * new files and processes, as prefer-coding-system; `interactive` says
 * what was done, as the command does.
 */
export function preferCodingSystem(coding: string, interactive = false): void {
  const type = e8.codingSystemType(coding);
  if (type === "raw-text" || type === "undecided") throw new Error(`Can't prefer the coding system \`${coding}'`);
  let base = String(e8.codingSystemBase(coding));
  const eol = e8.codingSystemEolType(coding);
  e8.setCodingSystemPriority(base);
  if (interactive && base !== coding) e8.message(`Highest priority is set to ${base} (base of ${coding})`);
  if (typeof eol === "number") base = e8.codingSystemChangeEolConversion(base, eol);
  setDefaultCodingSystems(base);
  if (interactive && base !== e8.variable("default-file-name-coding-system")) {
    e8.message(
      "The default value of `file-name-coding-system' was not changed because the specified coding system is not suitable for file names.",
    );
  }
}

e8.defineCommand({
  name: "revert-buffer-with-coding-system",
  doc:
    "Visit the buffer's file again, reading it in another coding system: for a file that was read wrongly.\n\n" +
    "Without line ends in the name, the buffer's are kept; with a prefix argument, the coding system is used as given.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg) => {
    const given = await readCodingSystem("Coding system for visited file (default nil): ");
    const coding = given !== undefined && arg === null ? mergeCodingSystems(given, bufferCoding()) : given;
    if (coding === undefined) {
      e8.call("revert-buffer");
      return;
    }
    withCoding(["coding-system-for-read"], coding, () => e8.call("revert-buffer"));
  },
});

e8.defineCommand({
  name: "universal-coding-system-argument",
  doc:
    "Read a coding system, then a key sequence, and run its command with files read and written in that coding system.\n\n" +
    "C-x RET c utf-16 C-x C-f visits a file as UTF-16, and C-x RET c latin-1 C-x C-s saves the buffer in Latin-1.",
  run: async () => {
    const coding = await readCodingSystem("Coding system for following command: ");
    if (coding === undefined) return;
    const keys = await e8.readKeySequence(`Command to execute with ${coding}:`);
    const command = e8.currentActiveMaps().map((map) => e8.lookupKey(map, keys)).find((b) => typeof b === "string");
    if (typeof command !== "string") throw new Error(`${keys} is undefined`);
    // Writing checks the coding can write the text even so, as Emacs binds coding-system-require-warning.
    withCoding(["coding-system-for-read", "coding-system-for-write"], coding, () =>
      e8.letBind({ "coding-system-require-warning": true }, () => e8.callInteractively(command as e8.CommandName)),
    );
  },
});

e8.defineVariable({
  name: "select-safe-coding-system-accept-default-p",
  doc: "A function select-safe-coding-system asks whether a safe default coding may be used without asking, overriding its own; nil for none.",
  value: null,
});
e8.defineVariable({ name: "last-coding-system-specified", doc: "The coding system last chosen by name in the minibuffer.", value: null });

/** Whether two coding systems are the same, line ends included, as coding-system-equal. */
function codingSystemEqual(a: string, b: string): boolean {
  return e8.codingSystemBase(a) === e8.codingSystemBase(b) && JSON.stringify(e8.codingSystemEolType(a)) === JSON.stringify(e8.codingSystemEolType(b));
}

/**
 * Safe coding systems put as users would rather see them, as
 * sanitize-coding-system-list: by their MIME names where those are the
 * same coding, without ISO 2022's locking shifts, and raw-text,
 * emacs-mule and no-conversion only if nothing else can.
 */
export function sanitizeCodingSystemList(codings: string[]): string[] {
  const named = codings.map((cs) => {
    const mime = e8.codingSystemGet(cs, ":mime-charset");
    return typeof mime === "string" && e8.codingSystemP(mime) && codingSystemEqual(cs, mime) ? mime : cs;
  });
  const shifting = ["coding-category-iso-7-else", "coding-category-iso-8-else"];
  const kept = named.filter((cs) => !shifting.includes(String(e8.codingSystemGet(cs, ":category"))));
  const rest = kept.filter((cs) => !["raw-text", "emacs-mule", "no-conversion"].includes(cs));
  return rest.length > 0 ? rest : kept;
}

/** A coding that could not write the text, with where (as shown) and which characters it could not. */
type Unsafe = [string, [number, string][]];

/** The table of what each default could not write, five characters each, as select-safe-coding-system--format-list. */
function insertUnsafeTable(unsafe: Unsafe[]): void {
  const row = (coding: string, pos: string, code: string, char: string) => `  ${coding.padEnd(20)} ${pos.padStart(6)}  ${code.padEnd(10)} ${char}\n`;
  e8.insert(row("Coding System", "Pos", "Codepoint", "Char"));
  for (const [coding, pairs] of unsafe) {
    pairs.slice(0, 5).forEach(([pos, char], i) => {
      const hex = char.codePointAt(0)!.toString(16).toUpperCase();
      e8.insert(row(i === 0 ? coding : "", String(pos), `#x${hex.padEnd(8)}`, char));
    });
    if (pairs.length > 5) e8.insert(row("", "...", "", ""));
  }
  e8.insert("\n");
}

/**
 * Asks which coding system to write text in when none of the defaults
 * can, as select-safe-coding-system-interactively: *Warning* shows the
 * characters each default cannot write, which RET on one goes to, and
 * the codings that can, the first of them the default answer.
 */
export function selectSafeCodingSystemInteractively(
  from: number | string,
  to: number | null,
  codings: string[],
  unsafeCodings: string[],
  rejected: string[] = [],
  defaultCoding?: string,
): string {
  const text = typeof from === "string" ? [...from] : undefined;
  const unsafe: Unsafe[] = unsafeCodings.map((coding) => {
    const found =
      text !== undefined ? e8.unencodableCharPosition(0, text.length, coding, 11, from as string) : e8.unencodableCharPosition(from as number, to!, coding, 11);
    const positions = Array.isArray(found) ? found : found === undefined ? [] : [found];
    // A buffer's positions as Emacs counts them, from 1; a string's from 0.
    return [coding, positions.map((p): [number, string] => (text !== undefined ? [p, text[p]] : [p + 1, e8.charAfter(p) ?? ""]))];
  });
  const safe = sanitizeCodingSystemList(codings);
  const config = e8.currentWindowConfiguration();
  const bufname = e8.bufferName();
  e8.saveExcursion(() => {
    if (unsafe.length > 0 && text === undefined) {
      e8.call("pop-to-buffer", bufname);
      e8.gotoChar(Math.min(...unsafe.map(([, pairs]) => (pairs.length > 0 ? pairs[0][0] - 1 : e8.pointMax()))));
    }
    const warning = e8.getBufferCreate("*Warning*");
    e8.withCurrentBuffer(warning, () => {
      if (e8.variable("major-mode") !== "help-mode") e8.call("help-mode");
      e8.letBind({ "inhibit-read-only": true }, () => {
        e8.deleteRegion(e8.pointMin(), e8.pointMax());
        insertWarning(from, text, bufname, safe, unsafe, rejected);
        e8.gotoChar(e8.pointMin());
      });
      e8.setBufferModified(false);
    });
    e8.call("display-buffer", "*Warning*");
  });
  const prompt = defaultCoding === undefined ? "Select coding system: " : `Select coding system (default ${defaultCoding}): `;
  const answer = e8.completingRead(prompt, e8.codingSystemList(), { history: "coding-system-history" });
  const coding = e8.checkCodingSystem(answer === "" ? (defaultCoding ?? null) : answer) ?? null;
  e8.setVariable("last-coding-system-specified", coding);
  e8.call("kill-buffer", "*Warning*");
  e8.setWindowConfiguration(config);
  return coding as string;
}

/** What *Warning* says, as select-safe-coding-system-interactively writes it. */
function insertWarning(from: number | string, text: string[] | undefined, bufname: string, safe: string[], unsafe: Unsafe[], rejected: string[]): void {
  if (rejected.length === 0 && unsafe.length === 0) {
    e8.insert(`No default coding systems to try for ${text !== undefined ? `string "${from}".` : `buffer \u2018${bufname}\u2019.`}`);
  } else {
    const what =
      text !== undefined
        ? ` "${text.length > 10 ? `${text.slice(0, 10).join("")}..."` : `${from}"`}`
        : ` the following\nproblematic characters in the buffer \u2018${bufname}\u2019`;
    e8.insert(`These default coding systems were tried to safely encode${what}:\n`);
    insertUnsafeTable(unsafe);
    if (rejected.length > 0) {
      e8.insert("These safely encode the text in the buffer,\nbut are not recommended for encoding text in this context,\ne.g., for sending an email message.\n ");
      for (const x of rejected) e8.insert(` ${x}`);
      e8.insert("\n");
    }
    if (unsafe.length > 0) {
      e8.insert(`${rejected.length > 0 ? "The other coding systems" : "However, each of them"} encountered characters it couldn\u2019t encode safely:\n`);
      for (const [coding, pairs] of unsafe) {
        e8.insert(`  ${coding} cannot safely encode these:`);
        pairs.forEach(([pos, char], i) => {
          e8.insert(" ");
          if (text !== undefined) e8.insert(i < 10 ? char : "...");
          else if (i < 10) e8.insert(button(char, "mouse-2, RET: jump to this character", ["call", "select-safe-coding-system--goto", bufname, String(pos - 1)]));
          else e8.insert(button("...", "mouse-2, RET: next unencodable character", ["call", "select-safe-coding-system--next", bufname, String(pos - 1), coding]));
        });
        e8.insert("\n");
      }
      e8.insert(
        substituteCommandKeys(
          "\nClick on a character (or switch to this window by \u2018\\[other-window]\u2019\n" +
            "and select the characters by RET) to jump to the place it appears,\n" +
            "where \u2018\\[universal-argument] \\[what-cursor-position]\u2019 will give information about it.\n",
        ),
      );
    }
  }
  e8.insert(
    substituteCommandKeys(
      "\nSelect one of the safe coding systems listed below,\n" +
        "or cancel the writing with \\[keyboard-quit] and edit the buffer\n" +
        "   to remove or modify the problematic characters,\n" +
        "or specify any other coding system (and risk losing\n" +
        "   the problematic characters).\n\n",
    ),
  );
  const start = e8.point();
  for (const x of safe) e8.insert(`  ${x}`);
  e8.insert("\n");
  e8.letBind({ "fill-prefix": "  " }, () => fillRegionAsParagraph(start, e8.point()));
}

/** The text with each \\[COMMAND] as the keys that run it, as substitute-command-keys puts them. */
function substituteCommandKeys(text: string): string {
  return text.replace(/\\\[([^\]]+)\]/g, (_, command: string) => e8.whereIsInternal(command)[0] ?? `M-x ${command}`);
}

/** A help-mode button that calls `xref`'s command with its arguments, as help-xref's help-function. */
function button(label: string, echo: string, xref: string[]): e8.PropertizedString {
  return e8.propertize(label, { face: "link", button: true, "help-echo": echo, "help-xref": xref as e8.Value });
}

e8.defineCommand({
  name: "select-safe-coding-system--goto",
  doc: "Show a buffer with point at a character its coding cannot write, as a *Warning* button does.",
  params: [{ name: "buffer", kind: "string" }, { name: "pos", kind: "string" }],
  run: (buffer: string, pos: string) => {
    if (!e8.getBuffer(buffer)) return;
    e8.call("pop-to-buffer", buffer);
    e8.gotoChar(Number(pos));
  },
});

e8.defineCommand({
  name: "select-safe-coding-system--next",
  doc: "Show a buffer with point at the next character its coding cannot write after the tenth, as *Warning*'s ... does.",
  params: [{ name: "buffer", kind: "string" }, { name: "pos", kind: "string" }, { name: "coding", kind: "string" }],
  run: (buffer: string, pos: string, coding: string) => {
    if (!e8.getBuffer(buffer)) return;
    e8.call("pop-to-buffer", buffer);
    if (e8.point() < Number(pos)) e8.gotoChar(Number(pos));
    else {
      const next = e8.unencodableCharPosition(e8.point() + 1, e8.pointMax(), coding);
      if (typeof next === "number") e8.gotoChar(next);
    }
  },
});

/** Whether the text from `from` to `to`, or the string `from`, holds anything but ASCII. */
function nonAscii(from: number | string, to: number | null): boolean {
  return /[^\x00-\x7f]/.test(typeof from === "string" ? from : e8.bufferSubstringNoProperties(from, to!));
}

/**
 * The coding system to write the text from `from` to `to`, or the string
 * `from`, in, as select-safe-coding-system: the first of the defaults —
 * `defaultCodingSystem`, the buffer's coding, its default, and the most
 * preferred coding if it has a MIME name — that can write it, unless
 * `acceptDefaultP` says no; a coding the file's text names wins over
 * them. When none can, asks, with *Warning* showing why; and asks
 * whether to save even so when the answer is not what the text names.
 */
export function selectSafeCodingSystem(
  from: number | string,
  to: number | null,
  defaultCodingSystem?: string | (string | true)[] | null,
  acceptDefaultP?: e8.Value,
  file?: string | null,
): string | undefined {
  let defaults: (string | true)[] = defaultCodingSystem == null ? [] : Array.isArray(defaultCodingSystem) ? [...defaultCodingSystem] : [defaultCodingSystem];
  let noOtherDefaults = false;
  let autoCs: string | undefined;
  if (typeof from !== "string" && !truthy(e8.variable("find-file-literally"))) {
    const found = e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        e8.gotoChar(from);
        return e8.findAutoCoding(file ?? e8.bufferFileName() ?? "", to! - from);
      }),
    );
    if (found !== undefined) autoCs = found[0];
  }
  if (defaults[0] === true) {
    noOtherDefaults = true;
    defaults = defaults.slice(1);
  }
  // Each default with its base coding.
  let pairs: [string, string][] = defaults.map((x) => [String(x), e8.codingSystemBase(String(x))]);
  const has = (base: string) => pairs.some(([, b]) => b === base);
  if (autoCs !== undefined && !noOtherDefaults) {
    let base = e8.codingSystemBase(autoCs);
    if (base !== "undecided") {
      // For writing, no-conversion-multibyte is no-conversion.
      if (base === "no-conversion-multibyte") autoCs = base = "no-conversion";
      pairs = [[autoCs, base]];
      noOtherDefaults = true;
    }
  }
  if (!noOtherDefaults) {
    const own = e8.variable("buffer-file-coding-system");
    if (typeof own === "string") {
      const base = e8.codingSystemBase(own);
      if (base !== "undecided" && !has(base)) pairs.push([own, base]);
    }
    const explicit = e8.variable("buffer-file-coding-system-explicit");
    if (!(Array.isArray(explicit) && truthy(explicit[1] as e8.Value))) {
      const dflt = e8.defaultValue("buffer-file-coding-system");
      if (typeof dflt === "string") {
        const base = e8.codingSystemBase(dflt);
        if (base !== "undecided" && !has(base)) pairs.push([dflt, base]);
      }
      const preferred = e8.codingSystemPriorityList(true)[0];
      if (preferred !== undefined && e8.codingSystemGet(preferred, ":mime-charset") !== undefined) {
        const base = e8.codingSystemBase(preferred);
        if (!has(base)) pairs.push([preferred, base]);
      }
    }
  }
  const accept = truthy(e8.variable("select-safe-coding-system-accept-default-p")) ? e8.variable("select-safe-coding-system-accept-default-p") : acceptDefaultP;
  // The line ends of the first default, else the buffer's, else its default's, for all of them.
  if (pairs.length > 0) {
    let eol = e8.codingSystemEolType(pairs[0][0]);
    const own = e8.variable("buffer-file-coding-system");
    if (Array.isArray(eol) && typeof own === "string") eol = e8.codingSystemEolType(own);
    const dflt = e8.defaultValue("buffer-file-coding-system");
    if (Array.isArray(eol) && typeof dflt === "string") eol = e8.codingSystemEolType(dflt);
    if (typeof eol === "number") pairs = pairs.map(([c, b]) => [e8.codingSystemChangeEolConversion(c, eol as number), b]);
  }
  let codings = typeof from === "string" ? e8.findCodingSystemsString(from) : e8.findCodingSystemsRegion(from, to!);
  const tick = typeof from === "string" ? undefined : e8.bufferCharsModifiedTick();
  let coding: string | undefined;
  const safe: string[] = [];
  const rejected: string[] = [];
  const unsafe: string[] = [];
  if (codings[0] === "undecided") coding = pairs[0]?.[0];
  else {
    for (const [c, base] of pairs) {
      if (!codings.includes(base)) unsafe.push(c);
      else if (accept !== undefined && accept !== null && !truthy(e8.funcall(accept as string, base) as e8.Value)) rejected.push(c);
      else safe.push(c);
    }
    coding = safe[0];
  }
  if (coding === undefined) {
    // UTF-8 first among them, as the default answer.
    if (codings.includes("utf-8")) codings = ["utf-8", ...codings.filter((c) => c !== "utf-8")];
    coding = selectSafeCodingSystemInteractively(from, to, codings, unsafe, rejected, codings[0]);
  }
  if (autoCs !== undefined) {
    if (coding === undefined) coding = autoCs;
    else {
      const eol1 = e8.codingSystemEolType(coding);
      const eol2 = e8.codingSystemEolType(autoCs);
      if (e8.codingSystemBase(coding) === "undecided") coding = e8.codingSystemChangeTextConversion(coding, autoCs);
      else if (e8.codingSystemBase(autoCs) === "undecided") autoCs = e8.codingSystemChangeTextConversion(autoCs, coding);
      if (Array.isArray(eol1)) {
        if (!Array.isArray(eol2)) coding = e8.codingSystemChangeEolConversion(coding, eol2);
      } else if (Array.isArray(eol2)) autoCs = e8.codingSystemChangeEolConversion(autoCs, eol1);
    }
    if (
      !e8.autoCodingAlistLookup(file ?? e8.bufferFileName() ?? "") &&
      !codingSystemEqual(coding, autoCs) &&
      (e8.codingSystemType(autoCs) === "charset" ||
        e8.codingSystemType(coding) === "charset" ||
        e8.codingSystemType(autoCs) !== e8.codingSystemType(coding)) &&
      !e8.yesOrNoP(`Selected encoding ${coding} disagrees with ${autoCs} specified by file contents.  Really save (else edit coding cookies and try again)? `)
    ) {
      e8.signal("error", "Save aborted");
    }
  }
  if (tick !== undefined && tick !== e8.bufferCharsModifiedTick()) e8.signal("error", "Canceled because the buffer was modified");
  if (coding !== undefined && e8.codingSystemType(coding) === "undecided" && truthy(e8.codingSystemGet(coding, ":prefer-utf-8") ?? null) && nonAscii(from, to)) {
    coding = e8.codingSystemChangeTextConversion(coding, "utf-8");
  }
  return coding;
}
e8.defun(
  "select-safe-coding-system",
  (from: number | string, to: number | null, dflt?: string | (string | true)[] | null, accept?: e8.Value, file?: string | null) =>
    selectSafeCodingSystem(from, to, dflt, accept, file) ?? null,
);
e8.setDefault("select-safe-coding-system-function", "select-safe-coding-system");

e8.bindKey("C-x RET f", "set-buffer-file-coding-system");
e8.bindKey("C-x RET r", "revert-buffer-with-coding-system");
e8.bindKey("C-x RET c", "universal-coding-system-argument");

/** Reads a coding system's name, asking again until one is given, as read-non-nil-coding-system. */
export function readNonNilCodingSystem(prompt: string): string {
  for (;;) {
    const name = e8.completingRead(prompt, e8.codingSystemList(), { history: "coding-system-history" });
    if (name !== "") return e8.checkCodingSystem(name) as string;
  }
}
e8.defun("read-non-nil-coding-system", (prompt: string) => readNonNilCodingSystem(prompt));

/**
 * Defines a coding system, as mule.el's define-coding-system: `props`
 * alternate keywords and values, `:coding-type` and `:mnemonic` first among
 * them, with `:charset-list` for a charset coding, `:bom` for UTF-8 and
 * UTF-16, `:endian` for UTF-16 and `:eol-type` to fix its line ends. The
 * rest go on its plist, for coding-system-get.
 */
export function defineCodingSystem(name: string, docstring: string, ...props: e8.Value[]): void {
  const get = (key: string): e8.Value => {
    for (let i = 0; i + 1 < props.length; i += 2) if (props[i] === key) return props[i + 1];
    return null;
  };
  const type = get(":coding-type");
  if (type === null) e8.signal("error", `Coding system type is not specified: ${name}`);
  const plist: e8.Value[] = [...props, ":name", name, ":docstring", docstring];
  const typeArgs: e8.Value[] = type === "utf-8" ? [get(":bom")] : type === "utf-16" ? [get(":bom"), get(":endian")] : [];
  e8.defineCodingSystemInternal(
    name,
    get(":mnemonic") ?? "-",
    type,
    get(":charset-list"),
    get(":ascii-compatible-p"),
    get(":decode-translation-table"),
    get(":encode-translation-table"),
    get(":post-read-conversion"),
    get(":pre-write-conversion"),
    get(":default-char"),
    get(":for-unibyte"),
    plist,
    get(":eol-type"),
    ...typeArgs,
  );
  // What coding-system-get gives back: the properties as given, and its
  // doc, but for those the coding system itself answers.
  const own = [":mnemonic", ":coding-type", ":name", ":mime-charset"];
  for (let i = 0; i + 1 < plist.length; i += 2) {
    const key = plist[i];
    if (typeof key === "string" && !own.includes(key)) e8.codingSystemPut(name, key, plist[i + 1]);
  }
}
e8.defun("define-coding-system", (name: string, docstring: string, ...props: e8.Value[]) => defineCodingSystem(name, docstring, ...props));

/**
 * Defines a charset, as mule.el's define-charset: `props` alternate
 * keywords and values, `:code-space` (a vector of each dimension's least
 * and greatest byte, least significant first) and one of `:code-offset`,
 * `:subset` (parent, least and greatest code, offset) or `:superset`
 * (charsets, each alone or with the offset of its codes) among them, with
 * `:iso-final-char` to give ISO 2022 a name for it.
 */
export function defineCharset(name: string, docstring: string, ...props: e8.Value[]): void {
  const get = (key: string): e8.Value => {
    for (let i = 0; i + 1 < props.length; i += 2) if (props[i] === key) return props[i + 1];
    return null;
  };
  const codeSpace = (get(":code-space") as number[] | null) ?? [0, 255, 0, 255, 0, 255, 0, 255];
  const dimension = (get(":dimension") as number | null) ?? codeSpace.length / 2;
  const plist: e8.Value[] = [":name", name, ":docstring", docstring, ...props, ":dimension", dimension, ":code-space", codeSpace];
  const finalChar = get(":iso-final-char");
  e8.defineCharsetInternal(
    name,
    dimension,
    codeSpace,
    get(":min-code"),
    get(":max-code"),
    typeof finalChar === "string" ? finalChar.codePointAt(0)! : finalChar,
    get(":iso-revision-number"),
    get(":emacs-mule-id"),
    get(":ascii-compatible-p"),
    get(":supplementary-p"),
    get(":invalid-code"),
    get(":code-offset"),
    get(":map"),
    get(":subset"),
    get(":superset"),
    get(":unify-map"),
    plist,
  );
}
e8.defun("define-charset", (name: string, docstring: string, ...props: e8.Value[]) => defineCharset(name, docstring, ...props));

/**
 * Calls `fn` with each range of characters a charset holds, as
 * [first, last], and `arg`, as map-charset-chars: its codes from `fromCode`
 * to `toCode`, all of them by default.
 */
export function mapCharsetChars(fn: string | ((range: [number, number], arg: e8.Value) => unknown), charset: string, arg: e8.Value = null, fromCode?: number | null, toCode?: number | null): void {
  for (const range of e8.charsetCharRanges(charset, fromCode, toCode)) e8.funcall(fn, range, arg);
}
e8.defun("map-charset-chars", (fn: string | ((range: [number, number], arg: e8.Value) => unknown), charset: string, arg?: e8.Value, fromCode?: number | null, toCode?: number | null) =>
  mapCharsetChars(fn, charset, arg ?? null, fromCode, toCode),
);

// Finding a file's coding from what it says, for file-coding-system-alist:
// xml-find-file-coding-system (mule.el), po-find-file-coding-system (po.el)
// and latexenc-find-file-coding-system (latexenc.el). Each is given the
// operation and its arguments, the file's name first.

/** The start of a file being read, enough to find what it declares. */
function fileHead(file: e8.Value): string | undefined {
  const name = Array.isArray(file) ? file[0] : file;
  if (typeof name !== "string" || !e8.fileExistsP(name)) return undefined;
  // Read undecoded, as the functions on file-coding-system-alist see the
  // bytes; each raw byte back to the character of that code, so the
  // head is the bytes as a string, as detectCodingString takes them.
  const buffer = e8.getBufferCreate(" *file-head*");
  return e8.withCurrentBuffer(buffer, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    const read = e8.conditionCase(
      () => (e8.letBind({ "coding-system-for-read": "no-conversion" }, () => e8.insertFileContents(name, { beg: 0, end: 8192 })), true),
      { error: () => false },
    );
    const text = read ? e8.bufferText() : undefined;
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    return text === undefined
      ? undefined
      : [...text].map((c) => (c.codePointAt(0)! >= 0x10ff80 ? String.fromCharCode(c.codePointAt(0)! - 0x10ff00) : c)).join("");
  });
}

const opName = (op: e8.Value): string => (typeof op === "symbol" ? (op as symbol).description ?? "" : String(op));

/**
 * The coding of an XML file without a declaration naming one, as
 * xml-find-file-coding-system: UTF-16 by its byte order mark, else UTF-8;
 * undecided for saving, which leaves the buffer's own.
 */
e8.defun("xml-find-file-coding-system", (args: e8.Value[]) => {
  if (opName(args[0]!) !== "insert-file-contents") return "undecided";
  const head = fileHead(args[1]!) ?? "";
  if (head.startsWith("\xef\xbb\xbf")) return "utf-8";
  const detected = head === "" ? "undecided" : e8.codingSystemBase(e8.detectCodingString(head, true));
  if (detected === "utf-16be-with-signature" || detected === "utf-16le-with-signature") return detected;
  if (detected !== "utf-8" && detected !== "undecided") {
    e8.message(`File contents detected as ${detected}.\n  Consider adding an xml declaration with the encoding specified,\n  or saving as utf-8, as mandated by the xml specification.`);
    return detected;
  }
  return "utf-8";
});

e8.defineVariable({
  name: "po-content-type-charset-alist",
  doc: "How a PO file's Content-Type charset names a coding system, for those whose names are not coding systems.",
  value: [["ASCII", "undecided"], ["ANSI_X3.4-1968", "undecided"], ["US-ASCII", "undecided"]],
});

/** A PO file's declared charset, as po-find-charset: its header's "charset=". */
function poCharset(head: string): string | undefined {
  return /charset=([-_A-Za-z0-9]+)/.exec(head)?.[1];
}

/**
 * The coding a PO file declares, as po-find-file-coding-system: its
 * header's charset, through po-content-type-charset-alist, else the coding
 * system of that name; only for reading.
 */
e8.defun("po-find-file-coding-system", (args: e8.Value[]) => {
  if (opName(args[0]!) !== "insert-file-contents") return null;
  const head = fileHead(args[1]!);
  if (head === undefined) return null;
  const charset = poCharset(head) ?? "ascii";
  const alist = (e8.variable("po-content-type-charset-alist") as [string, string][] | null) ?? [];
  const known = alist.find(([c]) => c.toLowerCase() === charset.toLowerCase())?.[1];
  const coding = known ?? [charset.toLowerCase(), charset.toLowerCase().replaceAll("_", "-")].find((c) => e8.codingSystemP(c));
  return coding === undefined ? null : [coding, null];
});

e8.defineVariable({
  name: "latex-inputenc-coding-alist",
  doc: "How LaTeX's inputenc encodings, as \\usepackage[latin1]{inputenc} names one, are coding systems.",
  value: [
    ["ansinew", "windows-1252"], ["applemac", "mac-roman"], ["ascii", "us-ascii"], ["cp1250", "windows-1250"], ["cp1252", "windows-1252"],
    ["cp1257", "cp1257"], ["cp437de", "cp437"], ["cp437", "cp437"], ["cp850", "cp850"], ["cp852", "cp852"], ["cp858", "cp858"], ["cp865", "cp865"],
    ["latin1", "iso-8859-1"], ["latin2", "iso-8859-2"], ["latin3", "iso-8859-3"], ["latin4", "iso-8859-4"], ["latin5", "iso-8859-9"],
    ["latin9", "iso-8859-15"], ["latin10", "iso-8859-16"], ["next", "next"], ["utf8", "utf-8"], ["utf8x", "utf-8"],
  ],
});

/** The coding an inputenc encoding name stands for, as latexenc-inputenc-to-coding-system. */
function inputencCoding(name: string): string | undefined {
  return ((e8.variable("latex-inputenc-coding-alist") as [string, string][] | null) ?? []).find(([n]) => n === name)?.[1];
}

/**
 * The coding a LaTeX file names with inputenc, as
 * latexenc-find-file-coding-system: \usepackage[ENC]{inputenc} or
 * \inputencoding{ENC} on a line not commented out, else the main file's
 * that a TeX-master local variable names; undecided if none says.
 */
e8.defun("latexenc-find-file-coding-system", (args: e8.Value[]) => {
  if (opName(args[0]!) !== "insert-file-contents") return null;
  const fromText = (text: string): string | undefined => {
    for (const line of text.split("\n")) {
      const m = /^[^%\n]*\\usepackage\[([^\]]*)\]\{(?:[^}]*,)?inputenc(?:,[^}]*)?\}/.exec(line) ?? /^[^%\n]*\\inputencoding\{([^}]*)\}/.exec(line);
      if (m) {
        const coding = inputencCoding(m[1]!) ?? m[1]!;
        return e8.codingSystemP(coding) ? coding : "undecided";
      }
    }
    return undefined;
  };
  const head = fileHead(args[1]!);
  if (head === undefined) return null;
  const found = fromText(head);
  if (found !== undefined) return found;
  // The main file a TeX-master local variable names.
  const name = String(Array.isArray(args[1]) ? args[1][0] : args[1]);
  const master = /^%+ *(?:TeX-master|tex-main-file): *"(.+)"/m.exec(head.slice(-3000))?.[1];
  if (master !== undefined) {
    const dir = e8.fileNameDirectory(name) ?? "";
    for (const ext of ["", ".tex", ".ltx", ".dtx", ".drv"]) {
      const main = e8.expandFileName(master + ext, dir);
      if (main !== name && e8.fileExistsP(main)) {
        const text = fileHead(main);
        const coding = text === undefined ? undefined : fromText(text);
        if (coding !== undefined) return coding;
        break;
      }
    }
  }
  return null;
});

// --- Characters by their Unicode names, after mule-cmds.el -----------------

/** The names `ucsNames` gives, by name, made the first time it is asked for. */
let ucsNamesTable: Map<string, number> | undefined;

/**
 * The characters by their Unicode names, as ucs-names: each name and old
 * name in the ranges Emacs reads, not the CJK ideographs and the others
 * named by their code.
 */
export function ucsNames(): Map<string, number> {
  ucsNamesTable ??= new Map(e8.ucsNamesInternal());
  return ucsNamesTable;
}
e8.defun("ucs-names", () => [...ucsNames()] as unknown as e8.Value);

/** A character's Unicode name, else its old name, as char-to-name; undefined for none. */
export function charToName(char: number): string | undefined {
  // Nil for what is no character, as characterp says.
  if (!Number.isInteger(char) || char < 0 || char > 0x3fffff) return undefined;
  const name = e8.getCharCodeProperty(char, "name") ?? e8.getCharCodeProperty(char, "old-name");
  return typeof name === "string" ? name : undefined;
}
e8.defun("char-to-name", (char: e8.Value) => (typeof char === "number" ? (charToName(char) ?? null) : null));

/**
 * The character a Unicode name names, as char-from-name: a name or old
 * name from ucs-names, or one made from a code, as VARIATION SELECTOR-17
 * or CJK COMPATIBILITY IDEOGRAPH-F900; `ignoreCase` folds case.
 */
export function charFromName(string: string, ignoreCase = false): number | undefined {
  const found = ucsNames().get(ignoreCase ? string.toUpperCase() : string);
  if (found !== undefined) return found;
  // Lower-case hex too, as case-fold-search is on for Emacs's match.
  const minus = /-[0-9A-F]+$/i.exec(string);
  if (!minus) return undefined;
  const vs = (ignoreCase ? /^VARIATION SELECTOR-/i : /^VARIATION SELECTOR-/).test(string);
  const minusNum = -parseInt(minus[0].slice(1), vs ? 10 : 16);
  if (Number.isNaN(minusNum)) return undefined;
  const offset = vs ? (minusNum < -16 ? 0xe00ef : 0xfdff) : 0;
  const code = offset - minusNum;
  if (code < 0 || code > 0x10ffff) return undefined;
  const name = e8.getCharCodeProperty(code, "name");
  if (typeof name !== "string") return undefined;
  return (ignoreCase ? name.toUpperCase() === string.toUpperCase() : name === string) ? code : undefined;
}
e8.defun("char-from-name", (string: string, ignoreCase?: e8.Value) => charFromName(String(string), truthy(ignoreCase ?? null)) ?? null);

e8.defineVariable({
  name: "read-char-by-name-sort",
  doc: "How read-char-by-name sorts the characters it completes: nil by name, \"code\" by code point.",
  value: null,
});

/**
 * Reads a character by its Unicode name or its code, as
 * read-char-by-name: a name or old name, completed, with the character
 * shown before each, a hex code as 2A10, or #x2a10, 10r10768 or #o25020;
 * with `allowSingle`, a character typed alone stands for itself.
 */
export function readCharByName(prompt: string, allowSingle = false): number {
  const names = ucsNames();
  const input = e8.letBind({ "completion-ignore-case": true, "enable-recursive-minibuffers": true }, () =>
    completingReadWithMetadata(prompt, names.keys(), {
      metadata: {
        category: "unicode-name",
        affixationFunction: (candidates) =>
          candidates.map((name) => {
            const c = names.get(name);
            return [name, `${c === undefined ? " " : String.fromCodePoint(c)}\t`, ""];
          }),
        displaySortFunction:
          e8.variable("read-char-by-name-sort") === "code"
            ? (candidates) => [...candidates].sort((a, b) => (names.get(a) ?? 0) - (names.get(b) ?? 0))
            : undefined,
        groupFunction: truthy(e8.variable("completions-group"))
          ? (name, transform) => {
              if (transform) return name;
              const c = names.get(name);
              return (c === undefined ? undefined : e8.charScript(c)) ?? "ungrouped";
            }
          : undefined,
      },
    }),
  ) as string;
  let char: number | undefined = charFromName(input, true);
  if (char === undefined && allowSingle && [...input].length === 1) char = input.codePointAt(0);
  if (char === undefined && /^[0-9A-Fa-f]+$/.test(input)) char = parseInt(input, 16);
  if (char === undefined) {
    const m = /^#(?:([bBoOxX])|([0-9]+)[rR])([0-9a-zA-Z]+)$/.exec(input);
    if (m) {
      const radix = m[1] ? ({ b: 2, o: 8, x: 16 } as Record<string, number>)[m[1].toLowerCase()] : Number(m[2]);
      // Every digit one of the radix's, as read would have it.
      const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, radix);
      if (radix >= 2 && radix <= 36 && [...m[3].toLowerCase()].every((d) => digits.includes(d))) char = parseInt(m[3], radix);
    }
  }
  // Emacs's raw bytes, #x3FFF80 up, are E8's from #x10FF80; its other
  // characters beyond Unicode E8 cannot hold.
  if (char !== undefined && char >= 0x3fff80 && char <= 0x3fffff) char = char - 0x3fff80 + 0x10ff80;
  if (char === undefined || char < 0 || char > 0x10ffff || (char >= 0xd800 && char <= 0xdfff)) e8.signal("error", "Invalid character");
  return char!;
}
e8.defun("read-char-by-name", (prompt: string, allowSingle?: e8.Value) => readCharByName(String(prompt), truthy(allowSingle ?? null)));

e8.defineCommand({
  name: "insert-char",
  doc:
    "Insert a character by its Unicode name or code, COUNT times: C-x 8 RET GREEK SMALL LETTER LAMBDA RET, or C-x 8 RET 3bb RET.\n\n" +
    "Names complete, and *Completions* shows each character before its name. Typed, the character inherits the text properties around it.",
  params: [
    { name: "character", value: () => String(readCharByName("Insert character (Unicode name or hex): ")) },
    { name: "count", kind: "count" },
  ],
  // Typed, it inherits, as Emacs's interactive spec passes INHERIT t.
  run: (character: string | number, count?: number) => {
    const code = typeof character === "number" ? character : Number(character);
    insertChar(code, count ?? 1, e8.calledInteractively());
  },
});
e8.bindKey("C-x 8 RET", "insert-char");

// --- Language environments, after mule-cmds.el ------------------------------

/** A language environment: its name, then each key with its information. */
type LanguageInfo = [string, ...[string, e8.Value][]];

e8.defineVariable({
  name: "language-info-alist",
  doc:
    "The language environments, each its name and then pairs of a key and its information: documentation, sample-text, " +
    "charset, coding-system, coding-priority, input-method, nonascii-translation, iso639-language, tutorial, " +
    "and setup-function and exit-function to call on entering and leaving it.",
  value: languages() as e8.Value,
});
e8.defineVariable({
  name: "current-language-environment",
  doc: "The language environment set-language-environment last set up.",
  value: "English",
});
e8.defineVariable({ name: "set-language-environment-hook", doc: "Run after a language environment is set up.", value: [] });
e8.defineVariable({
  name: "exit-language-environment-hook",
  doc: "Run when leaving a language environment, current-language-environment still naming it.",
  value: [],
});
e8.defineVariable({ name: "default-input-method", doc: "The input method a language environment names, for when one is turned on.", value: null });
e8.defineVariable({ name: "current-iso639-language", doc: "The ISO 639 language of the language environment, as a name such as \"ja\".", value: null });
e8.defineVariable({ name: "default-sendmail-coding-system", doc: "The coding system for mail sent from a buffer with none of its own.", value: "utf-8" });

/** The language environments as language-info-alist holds them now. */
function languageAlist(): LanguageInfo[] {
  const value = e8.variable("language-info-alist");
  return Array.isArray(value) ? (value as unknown as LanguageInfo[]) : [];
}

/** A language environment by name, any case, as assoc-string with case folded. */
function languageSlot(lang: string): LanguageInfo | undefined {
  const name = lang.toLowerCase();
  return languageAlist().find((l) => l[0].toLowerCase() === name);
}

/** What a language environment has under `key`, as get-language-info. */
export function getLanguageInfo(lang: string, key: string): e8.Value | undefined {
  const pair = languageSlot(lang)?.slice(1).find((p) => (p as [string, e8.Value])[0] === key) as [string, e8.Value] | undefined;
  return pair?.[1];
}
e8.defun("get-language-info", (lang: string, key: string) => getLanguageInfo(String(lang), String(key)) ?? null);

/** Stores `info` under `key` for a language environment, adding either if new, as set-language-info-internal. */
function setLanguageInfoInternal(lang: string, key: string, info: e8.Value): void {
  const all = languageAlist().map((l) => [...l] as LanguageInfo);
  let slot = all.find((l) => l[0] === lang);
  if (slot === undefined) {
    slot = [lang];
    all.unshift(slot);
  }
  const at = slot.findIndex((p, i) => i > 0 && (p as [string, e8.Value])[0] === key);
  if (at > 0) slot[at] = [key, info];
  else slot.splice(1, 0, [key, info]);
  e8.setVariable("language-info-alist", all as unknown as e8.Value);
}

/**
 * Stores `info` under `key` for a language environment, as
 * set-language-info, and puts it into effect if that is the current one.
 */
export function setLanguageInfo(lang: string, key: string, info: e8.Value): void {
  setLanguageInfoInternal(lang, key, info);
  if (lang !== e8.variable("current-language-environment")) return;
  if (key === "coding-priority") {
    setLanguageEnvironmentCodingSystems(lang);
    setLanguageEnvironmentCharset(lang);
  } else if (key === "input-method") setLanguageEnvironmentInputMethod(lang);
  else if (key === "charset") setLanguageEnvironmentCharset(lang);
}
e8.defun("set-language-info", (lang: string, key: string, info: e8.Value) => (setLanguageInfo(String(lang), String(key), info), null));

/**
 * Defines a language environment from pairs of a key and its
 * information, as set-language-info-alist, setting it up again if it is
 * the current one. E8 has no menus of them, so `parents` is not used.
 */
export function setLanguageInfoAlist(lang: string, alist: [string, e8.Value][], _parents?: e8.Value): void {
  for (const [key, info] of alist) setLanguageInfoInternal(lang, key, info);
  if (lang === e8.variable("current-language-environment")) setLanguageEnvironment(lang);
}
e8.defun("set-language-info-alist", (lang: string, alist: [string, e8.Value][], parents?: e8.Value) => (setLanguageInfoAlist(String(lang), alist, parents), null));

/** Reads a language environment's name, one with information under `key` if given, as read-language-name; undefined for none. */
export function readLanguageName(key: string | null, prompt: string, dflt?: string): string | undefined {
  const names = languageAlist()
    .filter((l) => key === null || l.slice(1).some((p) => (p as [string, e8.Value])[0] === key))
    .map((l) => l[0]);
  const name = e8.letBind({ "completion-ignore-case": true }, () =>
    e8.completingRead(prompt, names, { requireMatch: true, default: dflt }),
  ) as string;
  return name.length > 0 && (key === null || getLanguageInfo(name, key) !== undefined) ? name : undefined;
}

/**
 * Puts the coding systems back as they are with no language
 * environment, as reset-language-environment: UTF-8 first among those
 * detection tries, no default for new files, and processes reading
 * text undecided and writing UTF-8.
 */
export function resetLanguageEnvironment(): void {
  e8.setCodingSystemPriority(...["utf-8", "iso-2022-7bit", "iso-latin-1", "iso-2022-7bit-lock", "iso-2022-8bit-ss2", "emacs-mule", "raw-text"].filter((c) => e8.codingSystemP(c)));
  setDefaultCodingSystems(null);
  e8.setVariable("default-sendmail-coding-system", "utf-8");
  e8.setVariable("default-file-name-coding-system", "utf-8-unix");
  const process = e8.variable("default-process-coding-system");
  const [output, input] = Array.isArray(process) && process.length === 2 ? process.map(String) : ["undecided", "utf-8"];
  e8.setVariable("default-process-coding-system", [
    e8.codingSystemChangeTextConversion(output, "undecided"),
    e8.codingSystemChangeTextConversion(input, "utf-8"),
  ]);
  e8.setCharsetPriority("iso-8859-1");
}
e8.defineCommand({
  name: "reset-language-environment",
  doc: "Put the coding systems back as they are with no language environment: UTF-8 first for detection, and no default for new files.",
  run: () => resetLanguageEnvironment(),
});

/** A language's coding systems E8 has, in order. */
function languageCodings(lang: string, key: string): string[] {
  const value = getLanguageInfo(lang, key);
  return (Array.isArray(value) ? value.map(String) : []).filter((c) => e8.codingSystemP(c));
}

/** Makes a language environment's coding priority detection's, its first the default, as set-language-environment-coding-systems. */
function setLanguageEnvironmentCodingSystems(lang: string): void {
  const priority = languageCodings(lang, "coding-priority");
  if (priority.length === 0) return;
  const dflt = e8.defaultValue("buffer-file-coding-system");
  const eol = e8.codingSystemEolType(typeof dflt === "string" ? dflt : "utf-8-unix");
  setDefaultCodingSystems(typeof eol === "number" ? e8.codingSystemChangeEolConversion(priority[0], eol) : priority[0]);
  e8.setVariable("default-sendmail-coding-system", priority[0]);
  e8.setCodingSystemPriority(...priority);
}

/** Makes a language environment's input method the default, as set-language-environment-input-method. */
function setLanguageEnvironmentInputMethod(lang: string): void {
  const method = getLanguageInfo(lang, "input-method");
  if (typeof method === "string") e8.setVariable("default-input-method", method);
}

/** Puts first the charsets a language environment and its coding systems use, as set-language-environment-charset. */
function setLanguageEnvironmentCharset(lang: string): void {
  const own = getLanguageInfo(lang, "charset");
  const charsets = Array.isArray(own) ? own.map(String) : [];
  for (const coding of languageCodings(lang, "coding-priority")) {
    const list = e8.codingSystemGet(coding, ":charset-list");
    if (Array.isArray(list)) charsets.push(...list.map(String));
  }
  const known = charsets.filter((c) => e8.charsetp(c));
  if (known.length > 0) e8.setCharsetPriority(...known);
}

/**
 * What entering and leaving a language environment does beyond its
 * information, as its setup-function and exit-function in Emacs, for
 * those E8 can do.
 */
const LANGUAGE_FUNCTIONS: Record<string, { setup?: () => void; exit?: () => void }> = {
  // Japanese text is written in UTF-8 now, as setup-japanese-environment-internal prefers.
  Japanese: { setup: () => preferCodingSystem("utf-8") },
  // The middle dot is part of a word, as l·l is, in Catalan.
  Catalan: {
    setup: () => e8.modifySyntaxEntry("\u00b7", "w", e8.standardSyntaxTable()),
    exit: () => e8.modifySyntaxEntry("\u00b7", "_", e8.standardSyntaxTable()),
  },
};

/** What language environment entering and leaving it does, the alist's own functions first. */
function languageFunction(lang: string, key: "setup-function" | "exit-function"): (() => void) | undefined {
  const own = getLanguageInfo(lang, key);
  if (own !== undefined && own !== null) return () => e8.funcall(own as string);
  const slot = languageSlot(lang);
  return slot === undefined ? undefined : LANGUAGE_FUNCTIONS[slot[0]]?.[key === "setup-function" ? "setup" : "exit"];
}

/**
 * Sets up a language environment, as set-language-environment: leaves
 * the current one, puts the coding systems back as they are with none,
 * then makes this one's coding systems preferred, its first the
 * default for new files, its charsets first and its input method the
 * default, and runs set-language-environment-hook.
 */
export function setLanguageEnvironment(name: string | null): void {
  const slot = languageSlot(name ?? "English");
  if (slot === undefined) e8.signal("error", `Language environment not defined: "${name}"`);
  const lang = slot![0];
  const current = e8.variable("current-language-environment");
  if (typeof current === "string") {
    const exit = languageFunction(current, "exit-function");
    e8.runHooks("exit-language-environment-hook");
    exit?.();
  }
  resetLanguageEnvironment();
  e8.setVariable("current-language-environment", lang);
  setLanguageEnvironmentCodingSystems(lang);
  setLanguageEnvironmentInputMethod(lang);
  setLanguageEnvironmentCharset(lang);
  languageFunction(lang, "setup-function")?.();
  const iso639 = getLanguageInfo(lang, "iso639-language");
  if (iso639 !== undefined) e8.setVariable("current-iso639-language", iso639);
  e8.runHooks("set-language-environment-hook");
  e8.forceModeLineUpdate(true);
}

e8.defineCommand({
  name: "set-language-environment",
  doc:
    "Set up the editor for a language environment: the coding systems its files are read and written in, " +
    "its charsets and its input method. Latin-1 is for Western Europe's languages, Japanese for Japanese.",
  params: [
    {
      name: "language",
      prompt: "Set language environment (default English): ",
      collection: () => languageAlist().map((l) => l[0]),
    },
  ],
  // Nothing typed is English, as nil is to Emacs's.
  run: (language: string | null) => setLanguageEnvironment(language === null || language === "" ? null : String(language)),
});

/** Emacs's quoting, `like this', as substitute-command-keys turns it into curved quotes. */
function curveQuotes(text: string): string {
  return text.replace(/`([^`']*)'/g, "\u2018$1\u2019");
}

/** What describe-language-environment shows of a language environment. */
export function describeLanguageEnvironmentText(lang: string): string {
  const doc = getLanguageInfo(lang, "documentation");
  if (doc === undefined || doc === null) e8.signal("error", "No documentation for the specified language");
  let text = `${lang} language environment\n\n`;
  if (typeof doc === "string") text += `${substituteCommandKeys(curveQuotes(doc))}\n\n`;
  const sample = getLanguageInfo(lang, "sample-text");
  if (typeof sample === "string") text += `Sample text:\n  ${sample.replaceAll("\n", "\n  ")}\n\n`;
  text += "Character sets:\n";
  const charsets = (getLanguageInfo(lang, "charset") as e8.Value[] | undefined)?.map(String).filter((c) => e8.charsetp(c)) ?? [];
  if (charsets.length === 0) text += `  nothing specific to ${lang}\n`;
  for (const c of charsets) text += `  ${c}: ${String(e8.charsetPlist(c)[":docstring"] ?? "")}\n`;
  text += "\nCoding systems:\n";
  const codings = languageCodings(lang, "coding-system");
  if (codings.length === 0) text += `  nothing specific to ${lang}\n`;
  for (const c of codings) {
    const docstring = String(e8.codingSystemGet(c, ":docstring") ?? "");
    text += `  ${c} (\u2018${e8.codingSystemMnemonic(c)}\u2019 in mode line):\n\t${substituteCommandKeys(curveQuotes(docstring))}\n`;
    const aliases = e8.codingSystemAliases(c);
    if (aliases.length > 0) text += `\t(alias: ${aliases.join(" ")})\n`;
  }
  return text;
}

e8.defineCommand({
  name: "describe-language-environment",
  doc: "Show a language environment: what it is for, sample text, and the charsets and coding systems it uses.",
  params: [
    {
      name: "language",
      prompt: () => `Describe language environment (default ${String(e8.variable("current-language-environment") ?? "English")}): `,
      collection: () => languageAlist().filter((l) => getLanguageInfo(l[0], "documentation") !== undefined).map((l) => l[0]),
    },
  ],
  // In any case, as read-language-name folds it.
  run: (language: string | null) => {
    const current = String(e8.variable("current-language-environment") ?? "English");
    const lang = language === null || language === "" ? current : (languageSlot(String(language))?.[0] ?? String(language));
    e8.showHelp(describeLanguageEnvironmentText(lang));
  },
});
e8.bindKey("C-x RET l", "set-language-environment");
e8.bindKey("C-h L", "describe-language-environment");

// The table below is written by tests/emacs/languages.el.
/** Emacs's language environments, newest first, each with what it says of itself, as language-info-alist holds them. */
function languages(): LanguageInfo[] {
  return [
    ["Buginese", ["documentation", "Buginese language and its script Lontara are supported in this language environment."], ["sample-text", "Buginese (ᨒᨚᨈᨑ)    ᨖᨒᨚ"], ["input-method", "lontara"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Makasar", ["documentation", "Makassarese language and its script Makasar are supported in this language environment."], ["sample-text", "Makasar (𑻪𑻢𑻪𑻢)    𑻦𑻤𑻵𑻱"], ["input-method", "makasar"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Rejang", ["documentation", "Rejang language and its script are supported in this language environment."], ["sample-text", "Rejang (ꥆꤰ꥓ꤼꤽ ꤽꥍꤺꥏ)    ꤸꥉꥐꤺꥉꥂꥎ"], ["input-method", "rejang"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Batak", ["documentation", "Languages that use the Batak script, such as Karo, Toba, Pakpak, Mandailing\nand Simalungun, are supported in this language environment."], ["sample-text", "Batak (ᯘᯮᯒᯗ᯲ᯅᯗᯂ᯲)    ᯂᯬᯒᯘ᯲ / ᯔᯧᯐᯬᯀᯱᯐᯬᯀᯱ"], ["input-method", "batak"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Sundanese", ["documentation", "Sundanese language and its script are supported in this language environment."], ["sample-text", "Sundanese (ᮃᮊ᮪ᮞᮛᮞᮥᮔ᮪ᮓ)    ᮞᮙ᮪ᮕᮥᮛᮞᮥᮔ᮪"], ["input-method", "sundanese"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Javanese", ["documentation", "Javanese language and its script are supported in this language environment."], ["sample-text", "Javanese (ꦲꦏ꧀ꦱꦫꦗꦮ)\tꦲꦭꦺꦴ"], ["input-method", "javanese"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Balinese", ["documentation", "Balinese language and its script are supported in this language environment."], ["sample-text", "Balinese (ᬅᬓ᭄ᬱᬭᬩᬮᬶ)\tᬒᬁᬲ᭄ᬯᬲ᭄ᬢ᭄ᬬᬲ᭄ᬢᬸ"], ["input-method", "balinese"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Tagbanwa", ["documentation", "Philippine Languages Tagbanwa are supported in this language environment."], ["sample-text", "Tagbanwa (ᝦᝪᝯ)\tᝫᝩᝬᝥ ᝣᝮᝧᝯ"], ["input-method", "tagbanwa"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Buhid", ["documentation", "Philippine Language Buhid is supported in this language environment."], ["input-method", "buhid"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Hanunoo", ["documentation", "Philippine Language Hanunoo is supported in this language environment."], ["sample-text", "Hanunoo (ᜱᜨᜳᜨᜳᜢ)\tᜫᜬᜧ᜴ ᜣᜭᜯᜥ᜴ ᜰᜲᜭᜥ᜴"], ["input-method", "hanunoo"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Tagalog", ["documentation", "Tagalog language using the Baybayin script is supported in\nthis language environment."], ["sample-text", "Tagalog (ᜊᜌ᜔ᜊᜌᜒᜈ᜔)\tᜃᜓᜋᜓᜐ᜔ᜆ"], ["input-method", "tagalog"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Cham", ["documentation", "The Cham script is a Brahmic script used to write Cham,\nan Austronesian language spoken by some 245,000 Chams\nin Vietnam and Cambodia."], ["sample-text", "Cham (ꨌꩌ)\tꨦꨤꩌ ꨦꨁꨰ"], ["input-method", "cham"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Burmese", ["documentation", true], ["sample-text", "Burmese (မ္ရန္‌မာ)\tမင္‍ဂလာပာ"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Khmer", ["documentation", true], ["sample-text", "Khmer (ភាសាខ្មែរ)\tជំរាបសួរ"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Georgian", ["documentation", "Support for georgian-ps character set."], ["nonascii-translation", "georgian-ps"], ["input-method", "georgian"], ["coding-priority", ["georgian-ps"]], ["coding-system", ["georgian-ps"]]],
    ["UTF-8", ["documentation", "This language environment is a generic one for the Unicode character set\nencoded in UTF-8."], ["input-method", "rfc1345"], ["charset", ["unicode-bmp", "unicode"]], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]]],
    ["Mongolian-traditional", ["documentation", "Support for Mongolian language with traditional script."], ["sample-text", "Mongolian Traditional (ᠮᠣᠩᠭᠣᠯ ᠪᠢᠴᠢᠭ᠋)\tᠰᠠᠶᠢᠨ ᠪᠠᠶᠢᠨ᠎ᠠ ᠤᠤ?"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]]],
    ["Coptic", ["documentation", "Coptic language using the Coptic script is supported in this\nlanguage environment."], ["sample-text", "Coptic (ⲘⲉⲧⲢⲉⲙ̀ⲛⲭⲏⲙⲓ)\tⲚⲟⲩϥⲣⲓ"], ["input-method", "coptic"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Gothic", ["documentation", "Ancient Gothic language using the Gothic script is supported in this\nlanguage environment."], ["sample-text", "Gothic (𐌲𐌿𐍄𐌹𐍃𐌺𐌰)\t𐌷𐌰𐌹𐌻𐍃 / 𐌷𐌰𐌹𐌻𐌰"], ["input-method", "gothic"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Mende Kikakui", ["documentation", "Mende language and its script Kikakui are supported\nin this language environment."], ["sample-text", "Mende Kikakui (𞠀𞠁𞠂)\t𞠛𞠉"], ["input-method", "mende-kikakui"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Adlam", ["documentation", "Fulani language and its script Adlam are supported\nin this language environment."], ["sample-text", "Adlam (𞤀𞤣𞤤𞤢𞤥)\t𞤅𞤢𞤤𞤢𞥄𞤥"], ["input-method", "adlam"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Kharoshthi", ["documentation", "Language environment for Gāndhārī, Sanskrit, and other languages\nusing the Kharoṣṭhī script."], ["sample-text", "Kharoṣṭhī (𐨑𐨪𐨆𐨛𐨁)\t𐨣𐨨𐨲𐨪𐨆 𐨐𐨪𐨅𐨨𐨁"], ["input-method", "kharoshthi"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Hanifi Rohingya", ["documentation", "Rohingya language and its script Hanifi Rohingya are supported\nin this language environment."], ["sample-text", "Hanifi Rohingya (𐴌𐴟𐴇𐴥𐴝𐴚𐴒𐴙𐴝 𐴇𐴝𐴕𐴞𐴉𐴞 𐴓𐴠𐴑𐴤𐴝)\t𐴀𐴝𐴏𐴓𐴝𐴀𐴡𐴤𐴛𐴝𐴓𐴝𐴙𐴑𐴟𐴔"], ["input-method", "hanifi-rohingya"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Persian", ["tutorial", "TUTORIAL.fa"], ["documentation", "Bidirectional editing is supported."], ["sample-text", "Persian\tفارسی"], ["input-method", "farsi-transliterate-banan"], ["coding-priority", ["utf-8", "iso-8859-6", "windows-1256"]], ["coding-system", ["utf-8", "iso-8859-6", "windows-1256"]], ["charset", ["unicode"]]],
    ["Arabic", ["documentation", "Bidirectional editing is supported."], ["sample-text", "Arabic\tالسّلام عليكم"], ["input-method", "arabic"], ["coding-priority", ["utf-8", "iso-8859-6", "windows-1256"]], ["coding-system", ["utf-8", "iso-8859-6", "windows-1256"]], ["charset", ["unicode"]]],
    ["IPA", ["documentation", "IPA is International Phonetic Alphabet for English, French, German\nand Italian."], ["nonascii-translation", "ipa"], ["input-method", "ipa"], ["coding-system", ["utf-8"]], ["coding-priority", ["utf-8"]], ["charset", ["ipa"]]],
    ["Vietnamese", ["documentation", "For Vietnamese, Emacs uses special charsets internally.\nThey can be decoded from and encoded to VISCII, VSCII-1 (TCVN-5712),\nVIQR and windows-1258.  The current setting gives higher priority\nto the coding system VISCII than VSCII-1.  If you prefer VSCII-1,\nplease do: (prefer-coding-system 'vietnamese-vscii).  There are\ntwo Vietnamese input methods: VIQR and Telex, VIQR is the default\nsetting."], ["sample-text", "Vietnamese (Tiếng Việt)\tChào bạn"], ["input-method", "vietnamese-viqr"], ["coding-priority", ["vietnamese-viscii"]], ["nonascii-translation", "viscii"], ["coding-system", ["vietnamese-viscii", "vietnamese-vscii", "vietnamese-viqr", "windows-1258"]], ["charset", ["viscii"]]],
    ["Tibetan", ["documentation", true], ["input-method", "tibetan-wylie"], ["coding-priority", ["iso-2022-7bit", "tibetan-iso-8bit"]], ["coding-system", ["tibetan-iso-8bit"]], ["charset", ["tibetan", "tibetan-1-column"]]],
    ["Northern Thai", ["documentation", true], ["sample-text", "Northern Thai (ᨣᩣᩴᨾᩮᩬᩥᨦ / ᨽᩣᩈᩣᩃ᩶ᩣ᩠ᨶᨶᩣ)\tᩈ᩠ᩅᩢᩔ᩠ᨯᩦᨣᩕᩢ᩠ᨸ"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Thai", ["documentation", true], ["sample-text", "Thai (ภาษาไทย)\t\tสวัสดีครับ, สวัสดีค่ะ"], ["input-method", "thai-kesmanee"], ["nonascii-translation", "tis620-2533"], ["coding-priority", ["thai-tis620"]], ["coding-system", ["thai-tis620", "iso-8859-11", "cp874"]], ["charset", ["thai-tis620"]], ["tutorial", "TUTORIAL.th"]],
    ["TaiViet", ["documentation", "TaiViet refers to the Tai script, which is used to write several\nTai languages of northwestern Vietnam and surrounding areas.  These\nlanguages are Tai Dam (also known as Black Tai or Tai Noir),\nTai Dón (also known as White Tai or Tai Blanc), Tày Tac,\nTai Daeng (also known as Red Tai or Tai Rouge),\nand Thai Song (also known as Lao Song).  However, some people\nconsider Tai Dam, Tai Dón and Tai Daeng to be dialects of the\nsame language, and call them collectively \"Tai Viet\".\n\nBoth the script and languages have the same origin as that of Thai\nlanguage/script used in Thailand, but now they differ from each\nother in a significant way (especially the scripts are).\n\nThe language name is spelled as \"ꪁꪫꪱꪣ ꪼꪕ\", and the script name is\nspelled as \"ꪎꪳ ꪼꪕ\"."], ["sample-text", "TaiViet (ꪁꪫꪱꪣ ꪼꪕ)\t\tꪅꪰꪙꫂ ꪨꪮꫂ ꪁꪫꪱ / ꪅꪽ ꪨꪷ ꪁꪫꪱ"], ["input-method", "tai-sonla"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Lao", ["documentation", true], ["input-method", "lao"], ["coding-priority", ["lao"]], ["coding-system", ["lao"]], ["charset", ["lao"]]],
    ["Korean", ["documentation", "The following key bindings are available for controlling Korean input methods:\n  Shift-SPC, Hangul:\ttoggle-korean-input-method\n  Control-F9:\t\tquail-hangul-switch-symbol-ksc\n  F9:\t\t\tquail-hangul-switch-hanja\nand the following key bindings are available within Korean input methods:\n  F9, Hangul_Hanja:\thangul-to-hanja-conversion"], ["sample-text", "Hangul (한글)\t안녕하세요, 안녕하십니까"], ["coding-priority", ["korean-iso-8bit", "korean-cp949", "iso-2022-kr"]], ["input-method", "korean-hangul"], ["coding-system", ["iso-2022-kr", "korean-iso-8bit", "korean-cp949"]], ["charset", ["korean-ksc5601", "cp949"]], ["tutorial", "TUTORIAL.ko"], ["iso639-language", "ko"]],
    ["Japanese", ["documentation", true], ["sample-text", "Japanese (日本語)\tこんにちは, ｺﾝﾆﾁﾊ"], ["input-method", "japanese"], ["coding-priority", ["iso-2022-jp", "japanese-iso-8bit", "japanese-shift-jis", "iso-2022-jp-2004", "euc-jis-2004", "japanese-shift-jis-2004", "iso-2022-jp-2"]], ["coding-system", ["iso-2022-jp", "japanese-iso-8bit", "japanese-shift-jis", "japanese-iso-7bit-1978-irv", "iso-2022-jp-2004", "japanese-shift-jis-2004", "euc-jis-2004"]], ["charset", ["japanese-jisx0208", "japanese-jisx0212", "latin-jisx0201", "katakana-jisx0201", "japanese-jisx0213.2004-1", "japanese-jisx0213-1", "japanese-jisx0213-2", "japanese-jisx0208-1978"]], ["tutorial", "TUTORIAL.ja"], ["iso639-language", "ja"]],
    ["Windows-1255", ["documentation", "Support for Windows-1255 encoding, e.g. for Yiddish.\nBidirectional editing is supported."], ["coding-system", ["windows-1255"]], ["coding-priority", ["windows-1255"]]],
    ["Hebrew", ["documentation", "Bidirectional editing is supported."], ["sample-text", "Hebrew\tשלום"], ["input-method", "hebrew"], ["nonascii-translation", "iso-8859-8"], ["coding-system", ["hebrew-iso-8bit", "windows-1255", "cp862"]], ["coding-priority", ["hebrew-iso-8bit"]], ["charset", ["iso-8859-8"]], ["tutorial", "TUTORIAL.he"]],
    ["Greek", ["tutorial", "TUTORIAL.el_GR"], ["sample-text", "Greek (ελληνικά)\tΓειά σας"], ["documentation", "Support for Greek ISO-8859-7 using the greek input method."], ["input-method", "greek"], ["nonascii-translation", "iso-8859-7"], ["coding-priority", ["greek-iso-8bit"]], ["coding-system", ["greek-iso-8bit", "windows-1253", "cp851", "cp869"]], ["charset", ["iso-8859-7"]]],
    ["Romanian", ["documentation", "Romanian environment using Latin-2 encoding.\nAn environment for generic Latin-10 encoding is also available."], ["sample-text", "Bună ziua, bine aţi venit!"], ["tutorial", "TUTORIAL.ro"], ["input-method", "latin-2-postfix"], ["nonascii-translation", "iso-8859-2"], ["coding-priority", ["iso-8859-2"]], ["coding-system", ["iso-8859-2", "iso-latin-10"]], ["charset", ["iso-8859-2"]]],
    ["Slovak", ["documentation", "This language environment is almost the same as Latin-2,\nbut sets the default input method to \"slovak\",\nand selects the Slovak tutorial."], ["sample-text", "Prajeme Vám príjemný deň!"], ["tutorial", "TUTORIAL.sk"], ["input-method", "slovak"], ["nonascii-translation", "iso-8859-2"], ["coding-priority", ["iso-8859-2"]], ["coding-system", ["iso-8859-2"]], ["charset", ["ascii", "latin-iso8859-2"]]],
    ["Czech", ["documentation", "This language environment is almost the same as Latin-2,\nbut sets the default input method to \"czech\",\nand selects the Czech tutorial."], ["sample-text", "Přejeme vám hezký den!"], ["tutorial", "TUTORIAL.cs"], ["nonascii-translation", "iso-8859-2"], ["input-method", "czech"], ["coding-priority", ["iso-8859-2"]], ["coding-system", ["iso-8859-2"]], ["charset", ["ascii", "latin-iso8859-2"]]],
    ["Catalan", ["documentation", "This language environment uses the ISO-8859-1 character set,\nsets the default input method to \"catalan-prefix\", and sets\nthe syntax of the middle dot character `·' to word."], ["sample-text", "Catalan (Català)  Avui demà i ahir s'esfullarà una rosa."], ["nonascii-translation", "iso-8859-1"], ["input-method", "catalan-prefix"], ["coding-priority", ["iso-8859-1"]], ["coding-system", ["iso-8859-1", "iso-8859-15"]], ["charset", ["iso-8859-1"]]],
    ["Brazilian Portuguese", ["documentation", "Support for Brazilian Portuguese."], ["sample-text", "Oi"], ["input-method", "latin-1-prefix"], ["nonascii-translation", "iso-8859-1"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1", "iso-latin-9"]], ["charset", ["iso-8859-1"]], ["tutorial", "TUTORIAL.pt_BR"]],
    ["Croatian", ["documentation", "Support for Croatian with Latin-2 encoding."], ["nonascii-translation", "iso-8859-2"], ["input-method", "croatian"], ["coding-priority", ["iso-8859-2"]], ["coding-system", ["iso-8859-2"]], ["charset", ["iso-8859-2"]]],
    ["Swedish", ["documentation", "Support for Swedish"], ["sample-text", "Goddag Hej"], ["nonascii-translation", "iso-8859-1"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1"]], ["charset", ["iso-8859-1"]], ["tutorial", "TUTORIAL.sv"]],
    ["Latvian", ["documentation", "Support for Latvian."], ["input-method", "latvian-keyboard"], ["nonascii-translation", "iso-8859-13"], ["coding-priority", ["latin-7"]], ["coding-system", ["latin-7", "windows-1257"]]],
    ["Lithuanian", ["documentation", "Support for Lithuanian."], ["input-method", "lithuanian-keyboard"], ["nonascii-translation", "iso-8859-13"], ["coding-priority", ["latin-7"]], ["coding-system", ["latin-7", "windows-1257"]]],
    ["Welsh", ["documentation", "Support for Welsh, using Unicode."], ["input-method", "welsh"], ["nonascii-translation", "iso-8859-14"], ["coding-priority", ["utf-8", "latin-8"]], ["coding-system", ["utf-8", "latin-8"]]],
    ["Polish", ["documentation", true], ["sample-text", "Pójdź, kiń-że tę chmurność w głąb flaszy"], ["tutorial", "TUTORIAL.pl"], ["nonascii-translation", "iso-8859-2"], ["input-method", "polish-slash"], ["coding-priority", ["iso-8859-2"]], ["coding-system", ["iso-8859-2", "windows-1250"]], ["charset", ["iso-8859-2"]]],
    ["Turkish", ["documentation", "Support for Turkish.\nDiffers from the Latin-5 environment in using the `turkish-postfix' input\nmethod and applying Turkish case rules for the characters i, I, ı, İ."], ["sample-text", "Turkish (Türkçe)\tEsenlikler / Merhaba"], ["input-method", "turkish-postfix"], ["nonascii-translation", "iso-8859-9"], ["coding-priority", ["iso-latin-5"]], ["coding-system", ["iso-latin-5", "windows-1254", "iso-latin-3"]], ["charset", ["iso-8859-9"]]],
    ["Spanish", ["documentation", "This language environment is almost the same as Latin-1,\nbut it sets the default input method to \"spanish-postfix\",\nand it selects the Spanish tutorial."], ["sample-text", "Spanish (Español)\t¡Hola!"], ["nonascii-translation", "iso-8859-1"], ["input-method", "spanish-postfix"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1", "iso-latin-9"]], ["charset", ["iso-8859-1"]], ["tutorial", "TUTORIAL.es"]],
    ["Slovenian", ["documentation", "This language environment is almost the same as Latin-2,\nbut it selects the Slovenian tutorial and input method."], ["sample-text", "Želimo vam uspešen dan!"], ["tutorial", "TUTORIAL.sl"], ["input-method", "slovenian"], ["nonascii-translation", "iso-8859-2"], ["coding-priority", ["iso-8859-2"]], ["coding-system", ["iso-8859-2", "windows-1250"]], ["charset", ["iso-8859-2"]]],
    ["Italian", ["documentation", "This language environment is almost the same as Latin-1,\nbut sets the default input method to \"italian-postfix\".\nAdditionally, it selects the Italian tutorial."], ["sample-text", "Salve, ciao!"], ["input-method", "italian-postfix"], ["nonascii-translation", "iso-8859-1"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1", "iso-latin-9"]], ["charset", ["iso-8859-1"]], ["tutorial", "TUTORIAL.it"]],
    ["French", ["documentation", "This language environment is almost the same as Latin-1,\nbut it selects the French tutorial and input method."], ["sample-text", "French (Français)\tBonjour, Salut"], ["input-method", "latin-1-prefix"], ["nonascii-translation", "iso-8859-1"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1", "iso-latin-9"]], ["charset", ["iso-8859-1"]], ["tutorial", "TUTORIAL.fr"]],
    ["German", ["documentation", "This language environment is almost the same as Latin-1,\nbut sets the default input method to \"german-postfix\".\nAdditionally, it selects the German tutorial."], ["sample-text", "German (Deutsch Nord)\tGuten Tag\nGerman (Deutsch Süd)\tGrüß Gott"], ["input-method", "german-postfix"], ["nonascii-translation", "iso-8859-1"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1", "iso-latin-9"]], ["charset", ["iso-8859-1"]], ["tutorial", "TUTORIAL.de"]],
    ["Dutch", ["documentation", "This language environment is almost the same as Latin-1,\nbut it selects the Dutch tutorial and input method."], ["sample-text", "Er is een aantal manieren waarop je dit kan doen"], ["input-method", "dutch"], ["nonascii-translation", "iso-8859-1"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1", "iso-latin-9"]], ["charset", ["iso-8859-1"]], ["tutorial", "TUTORIAL.nl"]],
    ["Esperanto", ["documentation", "Support for Esperanto with ISO-8859-3 character set."], ["input-method", "latin-3-prefix"], ["nonascii-translation", "latin-iso8859-3"], ["coding-priority", ["iso-latin-3"]], ["coding-system", ["iso-latin-3"]], ["charset", ["iso-8859-3"]], ["tutorial", "TUTORIAL.eo"]],
    ["Latin-9", ["documentation", "This language environment is a generic one for the Latin-9 (ISO-8859-15)\ncharacter set which supports the same languages as Latin-1 with the\naddition of the Euro sign and some additional French and Finnish letters.\nLatin-9 is sometimes nicknamed `Latin-0'."], ["sample-text", "AVE. ŠšŽžŒœŸ €"], ["input-method", "latin-9-prefix"], ["nonascii-translation", "iso-8859-15"], ["coding-priority", ["iso-latin-9"]], ["coding-system", ["iso-latin-9"]], ["charset", ["iso-8859-15"]]],
    ["Latin-8", ["documentation", "This language environment is a generic one for the Latin-8 (ISO-8859-14)\ncharacter set which supports the Celtic languages, including those not\ncovered by other ISO-8859 character sets:\n Welsh, Manx Gaelic and Irish Gaelic (old orthography)."], ["sample-text", "ḃ ŵ Ŷ"], ["input-method", "latin-8-prefix"], ["nonascii-translation", "iso-8859-14"], ["coding-priority", ["iso-latin-8"]], ["coding-system", ["iso-latin-8"]], ["charset", ["iso-8859-14"]]],
    ["Latin-7", ["input-method", "latin-prefix"], ["documentation", "Support for Latin-7, e.g. Latvian, Lithuanian."], ["nonascii-translation", "iso-8859-13"], ["coding-priority", ["latin-7"]], ["coding-system", ["latin-7"]], ["charset", ["iso-8859-13"]]],
    ["Latin-6", ["input-method", "latin-prefix"], ["documentation", "Support for Latin-6."], ["coding-priority", ["latin-6"]], ["coding-system", ["latin-6"]], ["charset", ["iso-8859-10"]]],
    ["Latin-5", ["documentation", "Support for Latin-5.See also the Turkish environment."], ["input-method", "latin-5-postfix"], ["nonascii-translation", "iso-8859-9"], ["coding-priority", ["iso-latin-5"]], ["coding-system", ["iso-latin-5"]], ["charset", ["iso-8859-9"]]],
    ["Latin-4", ["documentation", "These languages are supported with the Latin-4 (ISO-8859-4) character set:\n Danish, English, Estonian, Finnish, German, Greenlandic, Latvian,\n Lithuanian, Norwegian, and Sami."], ["input-method", "latin-4-postfix"], ["nonascii-translation", "iso-8859-4"], ["coding-priority", ["iso-8859-4"]], ["coding-system", ["iso-8859-4"]], ["charset", ["iso-8859-4"]]],
    ["Latin-3", ["documentation", "These languages are supported with the Latin-3 (ISO-8859-3) character set:\n Afrikaans, Catalan, Dutch, English, Esperanto, French, Galician,\n German, Italian, Maltese, Spanish, and Turkish."], ["input-method", "latin-3-prefix"], ["nonascii-translation", "iso-8859-3"], ["coding-priority", ["iso-latin-3"]], ["coding-system", ["iso-latin-3"]], ["charset", ["iso-8859-3"]]],
    ["Latin-2", ["documentation", "This language environment is a generic one for the Latin-2 (ISO-8859-2)\ncharacter set which supports the following languages:\n Albanian, Czech, English, German, Hungarian, Polish, Romanian,\n Serbo-Croatian or Croatian, Slovak, Slovene, Sorbian (upper and lower),\n and Swedish.\nWe also have specific language environments for the following languages:\n  For Czech, \"Czech\".\n  For Croatian, \"Croatian\".\n  For Polish, \"Polish\".\n  For Romanian, \"Romanian\".\n  For Slovak, \"Slovak\"."], ["input-method", "latin-2-prefix"], ["nonascii-translation", "iso-8859-2"], ["coding-priority", ["iso-latin-2"]], ["coding-system", ["iso-latin-2", "windows-1250"]], ["charset", ["iso-8859-2"]]],
    ["Latin-1", ["documentation", "This language environment is a generic one for the Latin-1 (ISO-8859-1)\ncharacter set which supports the following European languages:\n Albanian, Basque, Breton, Catalan, Danish, Dutch, English, Faeroese,\n Finnish, French (with restrictions -- see Latin-9), Frisian, Galician,\n German, Greenlandic, Icelandic, Irish Gaelic (new orthography),\n Italian, Latin, Luxemburgish, Norwegian, Portuguese, Rhaeto-Romanic,\n Scottish Gaelic, Spanish, and Swedish.\nWe also have specific language environments for the following languages:\n  For Dutch, \"Dutch\".\n  For German, \"German\".\n  For French, \"French\".\n  For Italian, \"Italian\".\n  For Slovenian, \"Slovenian\".\n  For Spanish, \"Spanish\".\n\nLatin-1 also covers several written languages outside Europe, including\nIndonesian/Malay, Tagalog (Philippines), Swahili and Afrikaans."], ["sample-text", "Hello, Hej, Tere, Hei, Bonjour, Grüß Gott, Ciao, ¡Hola!"], ["input-method", "latin-1-prefix"], ["nonascii-translation", "iso-8859-1"], ["coding-priority", ["iso-latin-1"]], ["coding-system", ["iso-latin-1", "iso-latin-9", "windows-1252"]], ["charset", ["iso-8859-1"]]],
    ["Ethiopic", ["documentation", "This language environment provides these function key bindings:\n    [f3]   ethio-fidel-to-sera-buffer\n    [S-f3] ethio-fidel-to-sera-region\n    [C-f3] ethio-fidel-to-sera-marker\n\n    [f4]   ethio-sera-to-fidel-buffer\n    [S-f4] ethio-sera-to-fidel-region\n    [C-f4] ethio-sera-to-fidel-marker\n\n    [S-f5] ethio-toggle-punctuation\n    [S-f6] ethio-modify-vowel\n    [S-f7] ethio-replace-space\n\n    [S-f9] ethio-replace-space\n    [C-f9] ethio-toggle-space"], ["sample-text", "ፊደል"], ["input-method", "ethiopic"], ["coding-priority", ["utf-8-emacs"]], ["coding-system", ["utf-8-emacs"]], ["charset", ["ethiopic"]]],
    ["ASCII", ["tutorial", "TUTORIAL"], ["charset", ["ascii"]], ["sample-text", "Hello!, Hi!, How are you?"], ["documentation", "Nothing special is needed to handle English."]],
    ["English", ["documentation", "Nothing special is needed to handle English."], ["sample-text", "Hello!, Hi!, How are you?"], ["charset", ["ascii"]], ["tutorial", "TUTORIAL"]],
    ["Sinhala", ["documentation", true], ["sample-text", "Sinhala (සිංහල)\tආයුබෝවන්"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Toto", ["documentation", "Toto language using the Toto script is supported in this language\nenvironment."], ["input-method", "toto"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Wancho", ["documentation", "Wancho language and its script are supported in this language\nenvironment."], ["sample-text", "Wancho (𞋒𞋀𞋉𞋃𞋕)\t𞋂𞋈𞋛"], ["input-method", "wancho"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Meetei Mayek", ["documentation", "Meetei language and its script Meetei Mayek are supported in this\nlanguage environment."], ["sample-text", "Meetei Mayek (ꯃꯤꯇꯩ ꯃꯌꯦꯛ)\tꯈꯨꯔꯨꯝꯖꯔꯤ"], ["input-method", "meetei-mayek"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Lepcha", ["documentation", "Lepcha language and its script are supported in this\nlanguage environment."], ["sample-text", "Lepcha (ᰛᰩᰵᰛᰧᰵᰶ)\tᰂᰦᰕᰥᰬ"], ["input-method", "lepcha"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Grantha", ["documentation", "Languages such as Sanskrit and Manipravalam, when they use the\nGrantha script, are supported in this language environment."], ["sample-text", "Grantha (𑌗𑍍𑌰𑌨𑍍𑌥)\t𑌨𑌮𑌸𑍍𑌤𑍇 / 𑌨𑌮𑌸𑍍𑌕𑌾𑌰𑌃"], ["input-method", "grantha"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Limbu", ["documentation", "Limbu language and its script are supported in this\nlanguage environment."], ["sample-text", "Limbu (ᤕᤠᤰᤌᤢᤱ ᤐᤠᤴ)\tᤛᤣᤘᤠᤖᤥ"], ["input-method", "limbu"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Modi", ["documentation", "Marathi language and one of its script Modi are supported\nin this language environment."], ["sample-text", "Modi (𑘦𑘻𑘚𑘲)\t𑘡𑘦𑘭𑘿𑘎𑘰𑘨"], ["input-method", "modi"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Syloti Nagri", ["documentation", "Sylheti language and its script Syloti Nagri are supported\nin this language environment."], ["sample-text", "Syloti Nagri (ꠍꠤꠟꠐꠤ ꠘꠣꠉꠞꠤ)\tꠀꠌ꠆ꠍꠣꠟꠣꠝꠥ ꠀꠟꠣꠁꠇꠥꠝ / ꠘꠝꠡ꠆ꠇꠣꠞ"], ["input-method", "syloti-nagri"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Siddham", ["documentation", "Sanskrit language and one of its script Siddham are supported\nin this language environment."], ["sample-text", "Siddham (𑖭𑖰𑖟𑖿𑖠𑖽)\t𑖡𑖦𑖭𑖿𑖝𑖸"], ["input-method", "siddham"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Sharada", ["documentation", "Kashmiri language and its script Sharada are supported in this\nlanguage environment."], ["sample-text", "Sharada (𑆯𑆳𑆫𑆢𑆳)\t𑆤𑆩𑆱𑇀𑆑𑆳𑆫"], ["input-method", "sharada"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Tirhuta", ["documentation", "Maithili language and its script Tirhuta are supported in this\nlanguage environment."], ["sample-text", "Tirhuta (𑒞𑒱𑒩𑒯𑒳𑒞𑒰)\t𑒣𑓂𑒩𑒢𑒰𑒧 / 𑒮𑒲𑒞𑒰𑒩𑒰𑒧"], ["input-method", "tirhuta"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Kaithi", ["documentation", "Languages such as Awadhi, Bhojpuri, Magahi and Maithili\nwhich used the Kaithi script are supported in this language environment."], ["sample-text", "Kaithi (𑂍𑂶𑂟𑂲)\t𑂩𑂰𑂧𑂩𑂰𑂧"], ["input-method", "kaithi"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Brahmi", ["documentation", "The ancient Brahmi script is supported in this language environment."], ["sample-text", "Brahmi (𑀩𑁆𑀭𑀸𑀳𑁆𑀫𑀻)\t𑀦𑀫𑀲𑁆𑀢𑁂"], ["input-method", "brahmi"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Malayalam", ["documentation", "South Indian language Malayalam is supported in this language environment."], ["sample-text", "Malayalam (മലയാളം)\tനമസ്കാരം"], ["input-method", "malayalam-itrans"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Kannada", ["documentation", "Kannada language and script are supported in this language\nenvironment."], ["sample-text", "Kannada (ಕನ್ನಡ)\tನಮಸ್ಕಾರ"], ["input-method", "kannada-itrans"], ["coding-priority", ["mule-utf-8"]], ["coding-system", ["mule-utf-8"]], ["charset", ["unicode"]]],
    ["Telugu", ["documentation", "South Indian Language Telugu is supported in this language environment."], ["sample-text", "Telugu (తెలుగు)\tనమస్కారం"], ["input-method", "telugu-itrans"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Tamil", ["documentation", "South Indian Language Tamil is supported in this language environment."], ["sample-text", "Tamil (தமிழ்)\tவணக்கம்"], ["input-method", "tamil-phonetic"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Oriya", ["documentation", "Such languages using the Odia script as Odia, Khonti, and Santali\nare supported in this language environment."], ["sample-text", "Odia (ଓଡ଼ିଆ)\tନମସ୍କାର"], ["input-method", "odia"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Odia", ["documentation", "Such languages using the Odia script as Odia, Khonti, and Santali\nare supported in this language environment.  (This language\nenvironment was formerly known as \"Oriya\")."], ["sample-text", "Odia (ଓଡ଼ିଆ)\tନମସ୍କାର"], ["input-method", "odia"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Gujarati", ["documentation", "North Indian language Gujarati is supported in this language environment."], ["sample-text", "Gujarati (ગુજરાતી)\tનમસ્તે"], ["input-method", "gujarati-itrans"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Gurmukhi", ["documentation", "North Indian language Punjabi is supported in this language environment."], ["sample-text", "Gurmukhi (ਗੁਰਮੁਖੀ)\tਸਤ ਸ੍ਰੀ ਅਕਾਲ"], ["input-method", "punjabi-itrans"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Bengali", ["documentation", "Such languages using Bengali script as Bengali and Assamese\nare supported in this language environment."], ["sample-text", "Bengali (বাংলা)\tনমস্কার"], ["input-method", "bengali-itrans"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Devanagari", ["documentation", "Such languages using Devanagari script as Hindi, Marathi and Nepali\nare supported in this language environment."], ["sample-text", "Devanagari (देवनागरी)\tनमस्ते / नमस्कार"], ["input-method", "devanagari-aiba"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]], ["charset", ["unicode"]]],
    ["Mongolian-cyrillic", ["documentation", "Support for Mongolian language with Cyrillic alphabet."], ["sample-text", "Mongolian (монгол хэл)\tСайн байна уу?"], ["input-method", "cyrillic-mongolian"], ["coding-priority", ["utf-8"]], ["coding-system", ["utf-8"]]],
    ["Belarusian", ["documentation", "Support for Belarusian with windows-1251 character set.\n(The name Belarusian replaced Byelorussian in the early 1990s.)"], ["input-method", "belarusian"], ["charset", ["windows-1251"]], ["nonascii-translation", "windows-1251"], ["coding-priority", ["windows-1251"]], ["coding-system", ["windows-1251"]]],
    ["Bulgarian", ["documentation", "Support for Bulgarian with windows-1251 character set."], ["input-method", "bulgarian-bds"], ["charset", ["windows-1251"]], ["nonascii-translation", "windows-1251"], ["coding-priority", ["windows-1251"]], ["coding-system", ["windows-1251"]]],
    ["Tajik", ["documentation", "Support for Tajik using KOI8-T."], ["input-method", "russian-typewriter"], ["charset", ["koi8-t"]], ["nonascii-translation", "cyrillic-koi8-t"], ["coding-priority", ["koi8-t"]], ["coding-system", ["koi8-t"]]],
    ["Cyrillic-ALT", ["documentation", "Support for Cyrillic ALTERNATIVNYJ."], ["sample-text", "Russian (Русский)\tЗдравствуйте!"], ["input-method", "russian-typewriter"], ["nonascii-translation", "alternativnyj"], ["coding-priority", ["cyrillic-alternativnyj"]], ["coding-system", ["cyrillic-alternativnyj"]], ["charset", ["alternativnyj"]]],
    ["Ukrainian", ["documentation", "Support for Ukrainian with koi8-u character set."], ["sample-text", "Ukrainian (Українська)\tВітаю / Добрий день! / Привіт"], ["input-method", "ukrainian-computer"], ["nonascii-translation", "koi8-u"], ["coding-priority", ["koi8-u"]], ["coding-system", ["koi8-u"]], ["charset", ["koi8-u"]], ["tutorial", "TUTORIAL.uk"]],
    ["Russian", ["tutorial", "TUTORIAL.ru"], ["documentation", "Support for Russian using koi8-r and the russian-computer input method."], ["sample-text", "Russian (Русский)\tЗдравствуйте!"], ["input-method", "russian-computer"], ["coding-priority", ["cyrillic-koi8", "cyrillic-iso-8bit"]], ["coding-system", ["cyrillic-koi8"]], ["charset", ["cyrillic-iso8859-5"]]],
    ["Cyrillic-KOI8", ["documentation", "Support for Cyrillic KOI8-R."], ["sample-text", "Russian (Русский)\tЗдравствуйте!"], ["input-method", "russian-typewriter"], ["nonascii-translation", "koi8"], ["coding-priority", ["cyrillic-koi8", "cyrillic-iso-8bit"]], ["coding-system", ["cyrillic-koi8"]], ["charset", ["koi8"]]],
    ["Cyrillic-ISO", ["documentation", "Support for Cyrillic ISO-8859-5."], ["sample-text", "Russian (Русский)\tЗдравствуйте!"], ["nonascii-translation", "iso-8859-5"], ["input-method", "cyrillic-yawerty"], ["coding-priority", ["cyrillic-iso-8bit"]], ["coding-system", ["cyrillic-iso-8bit"]], ["charset", ["iso-8859-5"]]],
    ["Chinese-GB18030", ["tutorial", "TUTORIAL.cn"], ["documentation", "Support for Chinese GB18030 character set."], ["sample-text", "Chinese (中文,普通话,汉语) 你好"], ["input-method", "chinese-py-punct"], ["coding-priority", ["gb18030", "gbk", "iso-2022-cn", "chinese-big5", "chinese-iso-8bit"]], ["coding-system", ["chinese-gb18030"]], ["iso639-language", "zh"], ["charset", ["gb18030"]]],
    ["Chinese-GBK", ["tutorial", "TUTORIAL.cn"], ["documentation", "Support for Chinese GBK character set."], ["sample-text", "Chinese (中文,普通话,汉语) 妳好"], ["input-method", "chinese-py-punct"], ["coding-priority", ["gbk", "iso-2022-cn", "chinese-big5", "chinese-iso-8bit"]], ["coding-system", ["chinese-gbk"]], ["iso639-language", "zh"], ["charset", ["chinese-gbk"]]],
    ["Chinese-EUC-TW", ["documentation", "Support for Chinese, preferring the EUC-TW character set.  Note that\nthe EUC-TW coding system accepts Big5 for input also (which is then\nconverted to CNS)."], ["input-method", "chinese-cns-quick"], ["coding-priority", ["euc-tw", "chinese-big5", "iso-2022-cn", "chinese-iso-8bit", "chinese-gbk"]], ["coding-system", ["euc-tw", "iso-2022-cn"]], ["iso639-language", "zh"], ["charset", ["chinese-cns11643-1", "chinese-cns11643-2", "chinese-cns11643-3", "chinese-cns11643-4", "chinese-cns11643-5", "chinese-cns11643-6", "chinese-cns11643-7", "chinese-big5-1", "chinese-big5-2"]]],
    ["Chinese-CNS", ["documentation", "Support for Chinese CNS character sets.  Note that the EUC-TW coding system\naccepts Big5 for input also (which is then converted to CNS)."], ["input-method", "chinese-cns-quick"], ["coding-priority", ["iso-2022-cn", "euc-tw", "chinese-big5", "chinese-iso-8bit", "chinese-gbk"]], ["coding-system", ["iso-2022-cn", "euc-tw"]], ["iso639-language", "zh"], ["charset", ["chinese-cns11643-1", "chinese-cns11643-2", "chinese-cns11643-3", "chinese-cns11643-4", "chinese-cns11643-5", "chinese-cns11643-6", "chinese-cns11643-7"]]],
    ["Chinese-BIG5", ["tutorial", "TUTORIAL.zh"], ["documentation", "Support for Chinese Big5 character set."], ["sample-text", "Cantonese (粵語,廣東話)\t早晨, 你好"], ["input-method", "chinese-py-punct-b5"], ["coding-priority", ["chinese-big5", "iso-2022-cn", "chinese-iso-8bit", "chinese-gbk"]], ["coding-system", ["chinese-big5", "chinese-iso-7bit"]], ["iso639-language", "zh"], ["charset", ["chinese-big5-1", "chinese-big5-2"]]],
    ["Chinese-GB", ["tutorial", "TUTORIAL.cn"], ["documentation", "Support for Chinese GB2312 character set."], ["sample-text", "Chinese (中文,普通话,汉语)\t你好"], ["input-method", "chinese-py-punct"], ["coding-priority", ["chinese-iso-8bit", "chinese-gbk", "chinese-big5", "iso-2022-cn"]], ["coding-system", ["chinese-iso-8bit", "iso-2022-cn", "chinese-hz"]], ["iso639-language", "zh"], ["charset", ["chinese-gb2312", "chinese-sisheng"]]],
  ];
}
