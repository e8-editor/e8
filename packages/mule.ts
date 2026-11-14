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
    e8.setVariable("buffer-file-coding-system", mergeCodingSystems(coding, bufferCoding()));
    e8.setBufferModified(true);
  },
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
export function setDefaultCodingSystems(coding: string): void {
  e8.checkCodingSystem(coding);
  e8.setDefault("buffer-file-coding-system", coding);
  const process = e8.variable("default-process-coding-system");
  if (Array.isArray(process) && process.length === 2) {
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
    const type = e8.codingSystemType(coding);
    if (type === "raw-text" || type === "undecided") throw new Error(`Can't prefer the coding system \`${coding}'`);
    let base = String(e8.codingSystemBase(coding));
    const eol = e8.codingSystemEolType(coding);
    e8.setCodingSystemPriority(base);
    if (base !== coding) e8.message(`Highest priority is set to ${base} (base of ${coding})`);
    if (typeof eol === "number") base = e8.codingSystemChangeEolConversion(base, eol);
    setDefaultCodingSystems(base);
    if (base !== e8.variable("default-file-name-coding-system")) {
      e8.message(
        "The default value of `file-name-coding-system' was not changed because the specified coding system is not suitable for file names.",
      );
    }
  },
});

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
    withCoding(["coding-system-for-read", "coding-system-for-write"], coding, () => e8.callInteractively(command as e8.CommandName));
  },
});

/**
 * Before a buffer is written: if its coding system cannot write all of
 * its text, asks for one that can, as select-safe-coding-system does, and
 * makes it the buffer's.
 */
export function selectSafeCodingSystem(): void {
  const coding = (e8.variable("coding-system-for-write") as string | null) ?? bufferCoding();
  if (coding === undefined || e8.unencodableCharPosition(0, e8.bufferSize(), coding) === undefined) return;
  const safe = e8.findCodingSystemsRegion(0, e8.bufferSize());
  const fallback = safe[0] ?? "utf-8";
  const answer = e8.completingRead(`Select coding system (default ${fallback}): `, e8.codingSystemList(), { history: "coding-system-history" });
  const chosen = e8.checkCodingSystem(answer === "" ? fallback : answer) as string;
  e8.setVariable("buffer-file-coding-system", mergeCodingSystems(chosen, coding));
}

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
