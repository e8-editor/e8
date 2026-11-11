import { selectSafeCodingSystem } from "mule";

// Choosing a major mode for a file, after Emacs's files.el.

e8.defineVariable({
  name: "auto-mode-alist",
  doc:
    "Which major mode files get, by name: a list of [pattern, mode] pairs, tried in order.\n\n" +
    "Each pattern is an Emacs regular expression matched against the whole file name, as \\\\.txt\\\\', " +
    "and mode is the command that turns the mode on. Files that match nothing get Fundamental mode.",
  value: [["\\.te?xt\\'", "text-mode"]],
});

// File-local variables, after files.el: a file sets variables for its own
// buffer in its first line, -*- mode: org; fill-column: 60 -*-, or in a
// list near its end, between "Local Variables:" and "End:". Values are
// Lisp data, read as Lisp reads them. Safe values are set at once; for
// others E8 asks first, as enable-local-variables says.

const sym = (name: string): symbol => e8.intern(name);
const v = (name: string): e8.Value | undefined => e8.variable(name);
const list = (value: e8.Value | undefined): e8.Value[] => (Array.isArray(value) ? value : []);
const nameOf = (s: e8.Value): string => (typeof s === "symbol" ? e8.symbolName(s) : String(s));
const isSym = (value: e8.Value | undefined, name: string): boolean =>
  typeof value === "symbol" ? e8.symbolName(value) === name : value === name;
/** Lisp's truth: anything but nil. */
const truthy = (value: e8.Value | undefined): boolean => value !== undefined && value !== null && value !== false;

/** Whether two Lisp values are equal, as `equal` compares them. */
function equal(a: e8.Value | undefined, b: e8.Value | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if ((a === null || a === false || a === undefined) && (b === null || b === false || b === undefined)) return true;
  return false;
}

/** A variable-value pair, as (VAR . VAL) in the alists below. */
type Pair = [symbol, e8.Value];

const defvar = (name: string, value: e8.Value, doc: string, local = false) => e8.defineVariable({ name, value, doc, local });
defvar(
  "enable-local-variables",
  true,
  "Whether files' local variables are set: t sets them when all are safe and asks once about the rest; :safe sets " +
    "only the safe ones; :all sets them all; nil none; anything else asks every time. It also says whether a -*- line's mode is used.",
);
defvar("local-enable-local-variables", true, "Like enable-local-variables, but a -*- line's mode is still used; set it buffer-locally.", true);
defvar("enable-local-eval", sym("maybe"), "Whether a file's `eval:' entries are run: t runs them, nil ignores them, anything else asks.");
defvar("safe-local-variable-values", [], "Pairs (VAR . VAL) of values that are safe for those variables, as answering ! adds them.");
defvar("ignored-local-variable-values", [], "Pairs (VAR . VAL) a file's local variables never set, as answering i adds them.");
defvar(
  "ignored-local-variables",
  [sym("ignored-local-variables"), sym("safe-local-variable-values"), sym("file-local-variables-alist"), sym("dir-local-variables-alist")],
  "Variables a file's local variables never set.",
);
defvar(
  "safe-local-eval-forms",
  [
    [sym("add-hook"), [sym("quote"), sym("write-file-hooks")], [sym("quote"), sym("time-stamp")]],
    [sym("add-hook"), [sym("quote"), sym("write-file-functions")], [sym("quote"), sym("time-stamp")]],
    [sym("add-hook"), [sym("quote"), sym("before-save-hook")], [sym("quote"), sym("time-stamp")], null, true],
    [sym("add-hook"), [sym("quote"), sym("before-save-hook")], [sym("quote"), sym("delete-trailing-whitespace")], null, true],
  ],
  "Expressions a file's `eval:' may run without asking.",
);
defvar("permanently-enabled-local-variables", [sym("lexical-binding"), sym("read-symbol-shorthands")], "Local variables set even when local variables are not.");
defvar("file-local-variables-alist", [], "The pairs (VAR . VALUE) this buffer's file set as its local variables.", true);
defvar("dir-local-variables-alist", [], "The pairs (VAR . VALUE) this buffer's directory set, from .dir-locals.el.", true);
defvar(
  "inhibit-local-variables-regexps",
  ["\\.tar\\'", "\\.t[bg]z\\'", "\\.arc\\'", "\\.zip\\'", "\\.lzh\\'", "\\.lha\\'", "\\.zoo\\'", "\\.[jew]ar\\'", "\\.xpi\\'", "\\.rar\\'", "\\.7z\\'",
    "\\.sx[dmicw]\\'", "\\.odt\\'", "\\.diff\\'", "\\.patch\\'", "\\.tiff?\\'", "\\.gif\\'", "\\.png\\'", "\\.jpe?g\\'"],
  "File names whose files are not looked in for local variables, mostly binary formats.",
);
defvar("inhibit-local-variables-suffixes", [], "Suffixes taken off file names before inhibit-local-variables-regexps is matched.");
defvar("inhibit-local-variables-ignore-case", true, "Whether inhibit-local-variables-regexps ignores case.");
defvar("file-auto-mode-skip", "^\\(#!\\|'\\\\\"\\)", "A first line after which the -*- line is looked for on the second, as #! lines.");
e8.defineHook("before-hack-local-variables-hook", "Run before a file's local variables are set, when there are any, with file-local-variables-alist made.");

// Which variables are safe, as files.el marks those Emacs defines in C.
for (const [name, predicate] of [
  ["buffer-read-only", "booleanp"],
  ["default-directory", "stringp"],
  ["fill-column", "integerp"],
  ["indent-tabs-mode", "booleanp"],
  ["left-margin", "integerp"],
  ["inhibit-compacting-font-caches", "booleanp"],
  ["no-update-autoloads", "booleanp"],
  ["lexical-binding", "booleanp"],
  ["tab-width", "integerp"],
  ["truncate-lines", "booleanp"],
  ["word-wrap", "booleanp"],
  ["bidi-display-reordering", "booleanp"],
]) e8.put(name, "safe-local-variable", sym(predicate));
e8.put("bidi-paragraph-direction", "safe-local-variable", (value: e8.Value) => [null, sym("right-to-left"), sym("left-to-right")].some((x) => equal(x, value)));
for (const name of [
  "after-load-alist", "buffer-auto-save-file-name", "buffer-file-name", "buffer-file-truename", "buffer-undo-list", "debugger",
  "default-text-properties", "eval", "exec-directory", "exec-path", "file-name-handler-alist", "frame-title-format", "global-mode-string",
  "header-line-format", "icon-title-format", "inhibit-quit", "load-path", "max-lisp-eval-depth", "minor-mode-map-alist",
  "minor-mode-overriding-map-alist", "mode-line-format", "mode-name", "overriding-local-map", "overriding-terminal-local-map",
  "process-environment", "standard-input", "standard-output", "unread-command-events", "ignored-local-variables",
  "enable-local-variables", "enable-local-eval", "safe-local-variable-values", "ignored-local-variable-values", "safe-local-eval-forms",
]) e8.put(name, "risky-local-variable", true);

/** The predicates `safe-local-variable` properties name, as Lisp has them. */
const PREDICATES: Record<string, (x: e8.Value) => boolean> = {
  stringp: (x) => typeof x === "string",
  integerp: (x) => typeof x === "number" && Number.isInteger(x),
  natnump: (x) => typeof x === "number" && Number.isInteger(x) && x >= 0,
  fixnump: (x) => typeof x === "number" && Number.isInteger(x),
  numberp: (x) => typeof x === "number",
  floatp: (x) => typeof x === "number",
  booleanp: (x) => x === true || x === null || x === false,
  symbolp: (x) => typeof x === "symbol" || x === null || x === true || x === false,
  keywordp: (x) => typeof x === "symbol" && e8.symbolName(x).startsWith(":"),
  characterp: (x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0x3fffff,
  null: (x) => x === null || x === false,
  "string-or-null-p": (x) => typeof x === "string" || x === null || x === false,
  "list-of-strings-p": (x) => x === null || (Array.isArray(x) && x.every((s) => typeof s === "string")),
  listp: (x) => x === null || Array.isArray(x),
  consp: (x) => Array.isArray(x) && x.length > 0,
};

/** Calls a predicate a property names: a function, or the name of one. */
function callPredicate(predicate: e8.Value, value: e8.Value): boolean {
  if (typeof predicate === "function") return truthy(predicate(value) as e8.Value);
  const name = nameOf(predicate);
  if (PREDICATES[name] !== undefined) return PREDICATES[name](value);
  if (e8.fboundp(name)) return truthy(e8.funcall(name, value) as e8.Value);
  return false;
}

/** Whether a value is safe for a variable from a file, as safe-local-variable-p. */
export function safeLocalVariableP(variable: symbol, value: e8.Value): boolean {
  if (list(v("safe-local-variable-values")).some((pair) => equal(pair, [variable, value]))) return true;
  const predicate = e8.get(variable, "safe-local-variable");
  if (predicate === undefined || predicate === null || predicate === true) return false;
  try {
    return callPredicate(predicate, value);
  } catch (e) {
    e8.message(`Local variable error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Whether a variable could do harm when a file sets it, as risky-local-variable-p. */
export function riskyLocalVariableP(variable: symbol): boolean {
  return (
    truthy(e8.get(variable, "risky-local-variable")) ||
    /-hooks?$|-functions?$|-forms?$|-program$|-commands?$|-predicates?$|font-lock-keywords$|font-lock-keywords-[0-9]+$|font-lock-syntactic-keywords$|-frame-alist$|-mode-alist$|-map$|-map-alist$|-bindat-spec$/.test(
      e8.symbolName(variable),
    )
  );
}

/** Whether this buffer's file is one not looked in for local variables, as inhibit-local-variables-p. */
function inhibitLocalVariablesP(): boolean {
  const caseFold = truthy(v("inhibit-local-variables-ignore-case"));
  let name = e8.bufferFileName() ?? e8.bufferName();
  for (;;) {
    const suffix = list(v("inhibit-local-variables-suffixes")).map(String).find((re) => e8.stringMatch(re, name, { caseFold }) !== undefined);
    if (suffix === undefined) break;
    name = name.slice(0, e8.stringMatch(suffix, name, { caseFold }));
  }
  return list(v("inhibit-local-variables-regexps")).some((re) => e8.stringMatch(String(re), name, { caseFold }) !== undefined);
}

/** Where the -*- line's settings are, between its -*- marks, as set-auto-mode-1 finds them. */
export function propLineBounds(): [number, number] | undefined {
  if (inhibitLocalVariablesP()) return undefined;
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    // After a #! line, the second line, as a script's first line is its interpreter's.
    const first = e8.lineEndPosition(e8.pointMin());
    const skip = e8.lookingAt(String(v("file-auto-mode-skip") ?? "^#!"));
    const limit = skip && first < e8.pointMax() ? e8.lineEndPosition(first + 1) : first;
    const open = e8.search("-*-", { from: e8.pointMin(), bound: limit });
    if (open === undefined) return undefined;
    e8.gotoChar(open.end);
    e8.skipCharsForward(" \t");
    const beg = e8.point();
    const close = e8.search("-*-", { from: beg, bound: e8.lineEndPosition(beg) });
    if (close === undefined) return undefined;
    e8.gotoChar(close.start);
    e8.skipCharsBackward(" \t", beg);
    return [beg, e8.point()];
  });
}

const LOCAL_VARIABLE = /^[ \t]*([^\][;"'?()\\ \t\n]+)[ \t]*:[ \t]*/;

/** A mode named in a file as the major mode's command, as Emacs adds -mode. */
const modeCommand = (value: e8.Value, downcase: boolean): string => {
  const name = nameOf(value);
  return `${downcase ? name.toLowerCase() : name}-mode`;
};

/**
 * The -*- line's settings, as hack-local-variables-prop-line: with
 * `handleMode` true, the major mode it names; otherwise the variables it
 * sets, without `coding:`, and without `mode:` unless `handleMode` is nil.
 */
function propLineVariables(handleMode: boolean | "no-mode" | null): Pair[] | string | undefined {
  const bounds = propLineBounds();
  if (bounds === undefined) return handleMode === true ? undefined : [];
  const [beg, end] = bounds;
  const text = e8.bufferSubstringNoProperties(beg, end);
  // The simple form, -*- MODENAME -*-.
  const simple = /^[ \t]*([^ \t\n\r:;]+)[ \t]*-\*-/.exec(e8.bufferSubstringNoProperties(beg, e8.lineEndPosition(beg)));
  if (simple) return handleMode === true ? `${simple[1]}-mode` : [];
  const result: Pair[] = [];
  let i = 0;
  while (i < text.length) {
    if (handleMode === true && result.length > 0) break;
    const m = LOCAL_VARIABLE.exec(text.slice(i));
    if (!m) {
      e8.message(`Malformed mode-line: ${e8.prin1ToString(text.slice(i))} in buffer ${e8.prin1ToString(e8.bufferName())}`);
      return handleMode === true ? undefined : [];
    }
    i += m[0].length;
    const [value, after] = e8.readFromString(text, i);
    i = after;
    const keyname = m[1].toLowerCase();
    if (handleMode === true) {
      if (keyname === "mode") return modeCommand(value, true);
    } else if (keyname !== "coding" && (handleMode === null || keyname !== "mode")) {
      result.unshift([keyname === "mode" ? sym("mode") : sym(m[1]), value]);
    }
    while (i < text.length && " \t;".includes(text[i])) i++;
  }
  return handleMode === true ? undefined : result;
}

/**
 * The variables in the Local Variables list near the end of the buffer, as
 * hack-local-variables--find-variables: with `handleMode` true, the major
 * mode it names.
 */
function listVariables(handleMode: boolean | "no-mode" | null): Pair[] | string | undefined {
  return e8.saveExcursion(() => {
    const result: Pair[] = [];
    const max = e8.pointMax();
    const from = Math.max(max - 3000, e8.pointMin());
    const page = e8.search("\n\f", { from: max, backward: true, bound: from });
    const start = page === undefined ? from : page.start;
    const found = e8.search("Local Variables:", { from: start, caseFold: true });
    if (found === undefined) return handleMode === true ? undefined : result;
    e8.gotoChar(found.end);
    e8.skipCharsForward(" \t");
    const suffix = e8.bufferSubstringNoProperties(e8.point(), e8.lineEndPosition());
    const prefix = e8.bufferSubstringNoProperties(e8.lineBeginningPosition(found.start), found.start);
    const startpos = e8.lineEndPosition() + 1;
    if (startpos > max) return handleMode === true ? undefined : result;
    // The list ends at a line of the prefix, "End:" and the suffix.
    const endRe = `^${regexpQuoteLisp(prefix)}[ \t]*End:[ \t]*${regexpQuoteLisp(suffix)}$`;
    e8.gotoChar(startpos);
    let endpos: number;
    // Without an End: line it is not a list after all, and nothing is read.
    if (e8.reSearchForward(endRe, { noerror: true, caseFold: true }) === undefined) {
      e8.message("Local variables list is not properly terminated");
      endpos = startpos;
    } else endpos = e8.lineBeginningPosition(e8.point());
    // Each line without its prefix and suffix.
    const lines = e8.bufferSubstringNoProperties(startpos, Math.max(startpos, endpos)).split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const body = lines
      .map((line) => {
        if (!line.startsWith(prefix)) e8.userError("Local variables entry is missing the prefix");
        let rest = line.slice(prefix.length);
        if (!rest.endsWith(suffix)) e8.userError("Local variables entry is missing the suffix");
        if (suffix !== "") rest = rest.slice(0, rest.length - suffix.length);
        return rest;
      })
      .join("\n");
    let i = 0;
    while (i < body.length) {
      const eol = body.indexOf("\n", i);
      const lineEnd = eol < 0 ? body.length : eol;
      const m = LOCAL_VARIABLE.exec(body.slice(i, lineEnd + 1));
      if (!m) e8.userError(`Malformed local variable line: ${e8.prin1ToString(body.slice(i, lineEnd))}`);
      let variable = sym(m[1]);
      if (m[1].toLowerCase() === "mode") variable = sym("mode");
      i += m[0].length;
      const [value, after] = e8.readFromString(body, i);
      i = after;
      const name = e8.symbolName(variable);
      if (handleMode === true) {
        if (name === "mode") {
          const mode = nameOf(value).toLowerCase();
          if (!/-minor$/.test(mode) && e8.commandExists(`${mode}-mode`)) return `${mode}-mode`;
        }
      } else if (name === "coding") {
        // Used when the file was read, as set-auto-coding does.
      } else if (name === "mode" && handleMode !== null) {
        // The mode was chosen already.
      } else {
        result.unshift([variable, value]);
      }
      // On to the next line.
      const next = body.indexOf("\n", i);
      i = next < 0 ? body.length : next + 1;
    }
    return handleMode === true ? undefined : result;
  });
}

/** A string as a regexp matching it literally, as regexp-quote. */
function regexpQuoteLisp(s: string): string {
  return s.replace(/[[*.\\?+^$]/g, (c) => `\\${c}`);
}

/** Whether a quoted form, (quote X). */
const quotep = (exp: e8.Value): exp is e8.Value[] => Array.isArray(exp) && exp.length === 2 && isSym(exp[0], "quote");

/** Whether an `eval:` form is safe to run without asking, as hack-one-local-variable-eval-safep. */
function evalSafeP(exp: e8.Value): boolean {
  if (!Array.isArray(exp) || exp.length === 0) return true;
  const [head, ...args] = exp;
  if (isSym(head, "put") && quotep(args[0]) && quotep(args[1])) {
    const prop = nameOf(args[1][1]);
    const value = args[2];
    if (["lisp-indent-hook", "lisp-indent-function", "scheme-indent-function"].includes(prop)) {
      return typeof value === "number" || (quotep(value) && isSym(value[1], "defun"));
    }
  }
  if (list(v("safe-local-eval-forms")).some((form) => equal(form, exp))) return true;
  if (typeof head !== "symbol") return false;
  const name = e8.symbolName(head);
  if (/-mode$/.test(name) && (args.length === 0 || (args.length === 1 && [1, 0, -1].includes(args[0] as number)))) return true;
  const prop = e8.get(head, "safe-local-eval-function");
  if (prop === true) return args.every((a) => !Array.isArray(a) || quotep(a));
  if (typeof prop === "function" || typeof prop === "symbol") return callPredicate(prop, exp);
  if (Array.isArray(prop)) return prop.some((p) => callPredicate(p, exp));
  return false;
}

/**
 * Runs an `eval:` form. E8 has no Lisp, so it runs what a file's local
 * variables usually do: setting variables, adding a function to a hook,
 * and calling a function or command, with constant or quoted arguments.
 */
function evalForm(exp: e8.Value): e8.Value {
  if (typeof exp === "symbol") {
    const name = e8.symbolName(exp);
    return name.startsWith(":") ? exp : (v(name) ?? null);
  }
  if (!Array.isArray(exp) || exp.length === 0) return exp;
  const [head, ...args] = exp;
  const name = nameOf(head);
  if (name === "quote" || name === "function") return args[0] ?? null;
  if (name === "progn") return args.reduce<e8.Value>((_, a) => evalForm(a), null);
  if (name === "setq" || name === "setq-local") {
    let last: e8.Value = null;
    for (let k = 0; k + 1 < args.length; k += 2) {
      const variable = nameOf(args[k]);
      last = evalForm(args[k + 1]);
      if (name === "setq-local") e8.makeLocalVariable(variable);
      e8.setVariable(variable, last);
    }
    return last;
  }
  const values = args.map(evalForm);
  if (name === "add-hook" || name === "remove-hook") {
    const hook = nameOf(values[0]);
    const fn = values[1];
    const run = typeof fn === "function" ? fn : e8.symbolFunction(nameOf(fn)) ?? ((...a: e8.Value[]) => e8.funcall(nameOf(fn), ...a));
    const local = truthy(values[name === "add-hook" ? 3 : 2]);
    if (name === "add-hook") e8.addHook(hook, run, { local, ...(truthy(values[2]) ? { append: true } : {}) });
    else e8.removeHook(hook, run, { local });
    return null;
  }
  if (e8.fboundp(name)) return e8.funcall(name, ...values) as e8.Value;
  if (e8.commandExists(name)) {
    if (/-mode$/.test(name)) e8.callWithPrefix(values.length === 0 ? 1 : (values[0] as e8.PrefixArg), name as e8.CommandName);
    else (e8.call as (command: string, ...rest: e8.Value[]) => void)(name, ...values);
    return null;
  }
  return e8.signal("void-function", `Symbol’s function definition is void: ${name}`, [head]);
}

/**
 * Asks whether to set a file's local variables, showing them in *Local
 * Variables*, as hack-local-variables-confirm: true to set them.
 */
function confirm(all: Pair[], unsafe: Pair[], risky: Pair[], dirName?: string): boolean {
  if (truthy(v("noninteractive"))) return false;
  const file = e8.bufferFileName();
  const name = dirName ?? (file !== undefined ? e8.fileNameNondirectory(file) : `buffer ${e8.bufferName()}`);
  const offerSave = v("enable-local-variables") === true && unsafe.length > 0;
  const buffer = "*Local Variables*";
  e8.withCurrentBuffer(e8.getBufferCreate(buffer), () => {
    e8.letBind({ "inhibit-read-only": true }, () => e8.deleteRegion(e8.pointMin(), e8.pointMax()));
    if (unsafe.length > 0) {
      e8.insert(`The local variables list in ${name}\nor .dir-locals.el contains values that may not be safe (*)${risky.length > 0 ? ", and variables that are risky (**)." : "."}`);
    } else if (risky.length > 0) {
      e8.insert(`The local variables list in ${name}\ncontains variables that are risky (**).`);
    } else e8.insert(`A local variables list is specified in ${name}.`);
    e8.insert("\n\nDo you want to apply it?  You can type\ny  -- to apply the local variables list.\nn  -- to ignore the local variables list.");
    if (offerSave) {
      e8.insert(
        "\n!  -- to apply the local variables list, and permanently mark these\n      values (*) as safe (in the future, they will be set automatically.)" +
          "\ni  -- to ignore the local variables list, and permanently mark these\n      values (*) as ignored" +
          (dirName !== undefined
            ? "\n+  -- to apply the local variables list, and trust all directory-local\n      variables in this directory\n\n"
            : "\n\n"),
      );
    } else e8.insert("\n\n");
    for (const pair of all) {
      const mark = unsafe.includes(pair) ? "  * " : risky.includes(pair) ? " ** " : "    ";
      e8.insert(`${mark}${e8.symbolName(pair[0])} : ${e8.prin1ToString(pair[1]).replace(/\n/g, "\\n")}\n`);
    }
    e8.setBufferModified(false);
    e8.gotoChar(e8.pointMin());
  });
  const exits = offerSave ? ["y", "n", " ", "!", "i", ...(dirName !== undefined ? ["+"] : [])] : ["y", "n", " "];
  const prompt = `Please type ${offerSave ? (dirName !== undefined ? "y, n, !, i, +" : "y, n, !, i") : "y or n"}: `;
  const answer = e8.saveWindowExcursion(() => {
    e8.call("pop-to-buffer", buffer);
    for (;;) {
      const key = e8.readKey(prompt);
      const char = key === "SPC" ? " " : key;
      if (key === "C-g") e8.signal("quit", "Quit");
      if (key === "C-v" || key === "M-v") {
        e8.call(key === "C-v" ? "scroll-up-command" : "scroll-down-command");
        continue;
      }
      if (exits.includes(char)) return char;
    }
  });
  if (offerSave && dirName !== undefined && answer === "+") {
    e8.setDefault("safe-local-variable-directories", [dirName, ...list(e8.defaultValue("safe-local-variable-directories"))]);
  }
  if (offerSave && (answer === "!" || answer === "i")) {
    // Emacs saves the choice with customize-push-and-save; E8 keeps it for the session.
    const variable = answer === "!" ? "safe-local-variable-values" : "ignored-local-variable-values";
    e8.setDefault(variable, [...unsafe, ...list(e8.defaultValue(variable))]);
  }
  e8.call("kill-buffer", buffer);
  return ["!", " ", "y", "+"].includes(answer);
}

/**
 * Decides which of a file's variables to set, asking if need be, into
 * file-local-variables-alist, as hack-local-variables-filter: `dirName`
 * when they come from that directory's .dir-locals.el.
 */
function filterVariables(variables: Pair[], dirName?: string): void {
  const all: Pair[] = [];
  const risky: Pair[] = [];
  const unsafe: Pair[] = [];
  const enable = v("enable-local-variables");
  const safeOnly = isSym(enable, ":safe");
  for (const pair of variables) {
    const [variable, value] = pair;
    const name = e8.symbolName(variable);
    if (list(v("ignored-local-variables")).some((x) => isSym(x, name))) continue;
    if (list(v("ignored-local-variable-values")).some((x) => equal(x, pair))) continue;
    if (name === "eval") {
      const localEval = v("enable-local-eval");
      if (truthy(localEval)) {
        const safe = evalSafeP(value) || safeLocalVariableP(variable, value);
        if (safe || !safeOnly) {
          all.unshift(pair);
          if (localEval !== true && !safe) unsafe.unshift(pair);
        }
      }
    } else if (all.some((p) => p[0] === variable) && name !== "mode") {
      continue;
    } else if (["mode", "unibyte", "coding"].includes(name) || safeLocalVariableP(variable, value)) {
      all.unshift(pair);
    } else if (!safeOnly) {
      all.unshift(pair);
      if (riskyLocalVariableP(variable)) risky.unshift(pair);
      else unsafe.unshift(pair);
    }
  }
  if (all.length === 0) return;
  const trusted =
    dirName !== undefined &&
    list(v("safe-local-variable-directories")).some((d) => typeof d === "string" && e8.expandFileName(d) === e8.expandFileName(dirName));
  const ok =
    (enable === true && unsafe.length === 0 && risky.length === 0) ||
    isSym(enable, ":all") ||
    safeOnly ||
    trusted ||
    confirm(all, unsafe, risky, dirName);
  if (!ok) return;
  let alist = list(v("file-local-variables-alist")) as Pair[];
  for (const pair of all) {
    const name = e8.symbolName(pair[0]);
    if (name !== "eval" && name !== "mode") {
      if (dirName === undefined) {
        e8.setVariable("dir-local-variables-alist", (list(v("dir-local-variables-alist")) as Pair[]).filter((p) => p[0] !== pair[0]));
      }
      alist = alist.filter((p) => p[0] !== pair[0]);
    }
    alist = [pair, ...alist];
  }
  e8.setVariable("file-local-variables-alist", alist);
}

/** Sets one variable a file names, as hack-one-local-variable: `mode` turns its mode on, `eval` runs. */
function hackOneLocalVariable(variable: symbol, value: e8.Value): void {
  const name = e8.symbolName(variable);
  if (name === "mode") {
    const mode = modeCommand(value, true);
    if (mode === v("major-mode")) return;
    if (!e8.commandExists(mode)) {
      e8.message(`Ignoring unknown mode ‘${mode}’`);
      return;
    }
    e8.callWithPrefix(1, mode as e8.CommandName);
  } else if (name === "eval") {
    e8.saveExcursion(() => evalForm(value));
  } else {
    e8.makeLocalVariable(name);
    e8.setVariable(name, value);
  }
}

/** Sets the variables in file-local-variables-alist, then runs hack-local-variables-hook, as hack-local-variables-apply. */
function applyVariables(): void {
  const alist = list(v("file-local-variables-alist")) as Pair[];
  if (alist.length > 0) {
    const ordered = [...alist].reverse();
    e8.setVariable("file-local-variables-alist", ordered);
    e8.runHooks("before-hack-local-variables-hook");
    for (const [variable, value] of list(v("file-local-variables-alist")) as Pair[]) hackOneLocalVariable(variable, value);
  }
  e8.runHooks("hack-local-variables-hook");
}

/**
 * Sets this buffer's file-local variables, as hack-local-variables: with
 * `handleMode` true, only returns the major mode the file names; with
 * `no-mode`, leaves out `mode:`.
 */
export function hackLocalVariables(handleMode: boolean | "no-mode" | null = null, inhibitLocals = false): string | undefined {
  const enable = !inhibitLocals && truthy(v("local-enable-local-variables")) ? (v("enable-local-variables") ?? null) : null;
  return e8.letBind({ "enable-local-variables": enable }, () => {
    const enabled = truthy(v("enable-local-variables"));
    if (handleMode === true) {
      if (!enabled || inhibitLocalVariablesP()) return undefined;
      return (propLineVariables(true) as string | undefined) ?? (listVariables(true) as string | undefined);
    }
    e8.setVariable("file-local-variables-alist", []);
    try {
      hackDirLocalVariables();
    } catch (e) {
      e8.message(`Directory-local variables error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const result = [...(listVariables(handleMode) as Pair[]), ...(propLineVariables(handleMode) as Pair[])];
    if (enabled && !inhibitLocalVariablesP()) filterVariables(result);
    else {
      const always = list(v("permanently-enabled-local-variables"));
      const kept = result.filter((p) => always.some((x) => isSym(x, e8.symbolName(p[0]))));
      e8.setVariable("file-local-variables-alist", [...kept, ...(list(v("file-local-variables-alist")) as Pair[])]);
    }
    applyVariables();
    return undefined;
  });
}

// Directory-local variables, after files.el: a .dir-locals.el file in a
// directory, or one above it, sets variables for the files under it, by
// major mode and by subdirectory, as ((org-mode . ((fill-column . 60)))).
// .dir-locals-2.el beside it overrides it. They are read with the file's
// own local variables, and asked about the same way.

defvar("dir-locals-file", ".dir-locals.el", "The file that holds a directory's local variables; NAME-2.el beside it overrides it.");
defvar("enable-dir-local-variables", true, "Whether directory-local variables are used, as modes may turn off for their buffers.", true);
defvar("enable-remote-dir-locals", false, "Whether directory-local variables apply to remote files.");
defvar("safe-local-variable-directories", [], "Directories whose .dir-locals.el is trusted, risky or not, each absolute and ending in a slash.");
defvar("dir-locals-class-alist", [], "Each class of directory-local variables and its variables, as (CLASS . VARIABLES).");
defvar("dir-locals-directory-cache", [], "Each directory with a class of directory-local variables: (DIR CLASS MTIME), MTIME that of its files when read.");
defvar(
  "hack-dir-local-get-variables-functions",
  [sym("hack-dir-local--get-variables")],
  "Functions that give the directory-local variables for the buffer, as (DIR . ALIST) or a list of them.",
);
for (const name of ["safe-local-variable-directories", "enable-dir-local-variables", "dir-locals-class-alist", "dir-locals-directory-cache"]) {
  e8.put(name, "risky-local-variable", true);
}

/**
 * A (VAR . VALUE) entry of an alist as E8 reads it, its dotted end joining
 * the list: the value is the one element after the variable, or the rest
 * when there are more, and for `eval` always the rest, the form.
 */
function pairOf(entry: e8.Value): Pair | undefined {
  if (!Array.isArray(entry) || entry.length === 0 || typeof entry[0] !== "symbol") return undefined;
  const rest = entry.slice(1);
  if (e8.symbolName(entry[0]) === "eval") return [entry[0], rest.length === 0 ? null : rest];
  return [entry[0], rest.length === 0 ? null : rest.length === 1 ? rest[0] : rest];
}

/** A class's entries: a mode, nil or a subdirectory, each with what follows it. */
type DirEntry = [e8.Value, ...e8.Value[]];

/** The dir-locals files in a directory, lowest priority first, as dir-locals--all-files. */
function dirLocalsAllFiles(directory: string): string[] {
  if (!e8.fileReadableP(directory)) return [];
  const file1 = e8.expandFileName(String(v("dir-locals-file") ?? ".dir-locals.el"), directory);
  const file2 = /\.el$/.test(file1) ? file1.replace(/\.el$/, "-2.el") : undefined;
  const out: string[] = [];
  for (const f of [file2, file1]) {
    if (f !== undefined && e8.fileReadableP(f) && e8.fileAttributes(f)?.type !== "directory") out.unshift(f);
  }
  return out;
}

/** The latest modification time of a directory's dir-locals files. */
function latestTime(files: string[]): number {
  return files.reduce((latest, f) => Math.max(latest, e8.fileAttributes(f)?.modified ?? 0), 0);
}

/** The directory, with a slash, of a file or directory name. */
const asDirectory = (name: string): string => (name.endsWith("/") ? name : `${name}/`);

/**
 * Where a file's directory-local variables come from, as
 * dir-locals-find-file: a valid cache entry, the directory holding a
 * dir-locals file, or undefined.
 */
function dirLocalsFindFile(fileIn: string): e8.Value[] | string | undefined {
  // A directory name keeps its slash, so it is looked for in itself.
  const file = fileIn.endsWith("/") ? asDirectory(e8.expandFileName(fileIn)) : e8.expandFileName(fileIn);
  let localsDir: string | undefined;
  for (let dir = e8.fileNameDirectory(file); dir !== undefined; ) {
    if (dirLocalsAllFiles(dir).length > 0) {
      localsDir = asDirectory(e8.expandFileName(dir));
      break;
    }
    const parent = e8.fileNameDirectory(dir.replace(/\/$/, ""));
    if (parent === undefined || parent === dir) break;
    dir = parent;
  }
  let best: e8.Value[] | undefined;
  for (const elt of list(v("dir-locals-directory-cache"))) {
    if (!Array.isArray(elt) || typeof elt[0] !== "string") continue;
    if (file.startsWith(elt[0]) && elt[0].length > String(best?.[0] ?? "").length) best = elt;
  }
  if (best !== undefined && (localsDir === undefined || localsDir.length <= String(best[0]).length)) {
    const mtime = best[2];
    if (mtime === null || mtime === undefined || mtime === false) return best;
    const files = dirLocalsAllFiles(String(best[0]));
    if (files.length > 0 && latestTime(files) === mtime) return best;
    const stale = best;
    e8.setDefault("dir-locals-directory-cache", list(v("dir-locals-directory-cache")).filter((e) => e !== stale));
    return localsDir;
  }
  return localsDir;
}

/** The depth of a mode, how many parents it has, as dir-locals sorts by it. */
function sortScore(entry: e8.Value[]): number {
  const key = entry[0];
  if (key === null || key === false) return -1;
  if (typeof key === "symbol") return e8.derivedModeAllParents(e8.symbolName(key)).length;
  if (typeof key === "string") return 1000 + key.length;
  return -2;
}

/** Sorts a class's entries so later ones are more specific, as dir-locals--sort-variables. */
function sortVariables(variables: e8.Value[][]): e8.Value[][] {
  const sorted = variables.map((e, i) => [e, i] as const).sort((a, b) => sortScore(a[0]) - sortScore(b[0]) || a[1] - b[1]).map((x) => x[0]);
  return sorted.map((n) => (typeof n[0] === "string" ? [n[0], ...sortVariables(n.slice(1).filter(Array.isArray) as e8.Value[][])] : n));
}

/** Merges two files' entries for one key, the second's settings winning and every `eval` kept, as map-merge-with does. */
function mergeEntryValues(a: e8.Value[], b: e8.Value[]): e8.Value[] {
  const isEval = (e: e8.Value) => Array.isArray(e) && isSym(e[0], "eval");
  const merged: e8.Value[] = [];
  for (const e of [...a.filter((x) => !isEval(x)), ...b.filter((x) => !isEval(x))]) {
    const key = Array.isArray(e) ? e[0] : e;
    const at = merged.findIndex((m) => equal(Array.isArray(m) ? m[0] : m, key));
    if (at >= 0) merged[at] = e;
    else merged.push(e);
  }
  return [...merged, ...a.filter(isEval), ...b.filter(isEval)];
}

/** Reads a directory's dir-locals files into a class named after it, as dir-locals-read-from-dir. */
function dirLocalsReadFromDir(dir: string): symbol {
  const className = sym(dir);
  const files = dirLocalsAllFiles(dir);
  let variables: e8.Value[][] = [];
  let latest = 0;
  let success: number | null = 0;
  try {
    for (const file of files) {
      latest = Math.max(latest, e8.fileAttributes(file)?.modified ?? 0);
      const text = readFileText(file);
      let newvars: e8.Value = null;
      try {
        newvars = e8.readFromString(text)[0];
      } catch (e) {
        if (!(e instanceof Error && (e as { symbol?: string }).symbol === "end-of-file")) throw e;
      }
      if (newvars !== null && !Array.isArray(newvars)) {
        e8.message(`Invalid data in ${file}: ${e8.prin1ToString(newvars)}`);
        newvars = null;
      }
      const fresh = (newvars ?? []).filter(Array.isArray) as e8.Value[][];
      if (variables.length === 0 || fresh.length === 0) variables = variables.length === 0 ? fresh : variables;
      else {
        const out = variables.map((e) => [...e]);
        for (const entry of fresh) {
          const at = out.findIndex((o) => equal(o[0], entry[0]));
          if (at >= 0) out[at] = [entry[0], ...mergeEntryValues(out[at].slice(1), entry.slice(1))];
          else out.push(entry);
        }
        variables = out;
      }
    }
    success = latest;
  } catch (e) {
    e8.message(`Error reading dir-locals: ${e instanceof Error ? e.message : String(e)}`);
    success = 0;
  }
  setClassVariables(className, sortVariables(variables));
  setDirectoryClass(dir, className, success);
  return className;
}

/** A file's text. */
function readFileText(file: string): string {
  const buffer = e8.getBufferCreate(" *dir-locals*");
  return e8.withCurrentBuffer(buffer, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.insertFileContents(file);
    const text = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    return text;
  });
}

/** Maps a class to its variables, as dir-locals-set-class-variables. */
export function setClassVariables(className: e8.Value, variables: e8.Value[]): void {
  const alist = list(e8.defaultValue("dir-locals-class-alist")).filter((e) => !(Array.isArray(e) && equal(e[0], className)));
  e8.setDefault("dir-locals-class-alist", [[className, ...variables], ...alist]);
}

/** Declares a directory an instance of a class, as dir-locals-set-directory-class. */
export function setDirectoryClass(directory: string, className: e8.Value, mtime: number | null = null): void {
  const dir = asDirectory(e8.expandFileName(directory));
  if (!list(e8.defaultValue("dir-locals-class-alist")).some((e) => Array.isArray(e) && equal(e[0], className))) {
    e8.signal("error", `No such class ‘${nameOf(className)}’`);
  }
  e8.setDefault("dir-locals-directory-cache", [[dir, className, mtime], ...list(e8.defaultValue("dir-locals-directory-cache"))]);
}

function classVariables(className: e8.Value): e8.Value[][] {
  const entry = list(v("dir-locals-class-alist")).find((e) => Array.isArray(e) && equal(e[0], className));
  return Array.isArray(entry) ? (entry.slice(1).filter(Array.isArray) as e8.Value[][]) : [];
}

/** Adds a mode's settings to the variables, the last setting of each winning, as dir-locals-collect-mode-variables. */
function collectModeVariables(modeVariables: e8.Value[], variables: Pair[]): Pair[] {
  let out = variables;
  for (const entry of modeVariables) {
    const pair = pairOf(entry);
    if (pair === undefined) continue;
    const at = out.findIndex((p) => p[0] === pair[0]);
    if (at >= 0 && !["mode", "eval"].includes(e8.symbolName(pair[0]))) {
      out = out.slice();
      out[at] = pair;
    } else out = [pair, ...out];
  }
  return out;
}

/** The variables of a class that apply to this buffer, as dir-locals-collect-variables. */
function collectVariables(classVars: e8.Value[][], root: string, variablesIn: Pair[], predicate?: (key: e8.Value) => boolean): Pair[] {
  const fileName = e8.bufferFileName() ?? e8.expandFileName(String(v("default-directory") ?? "~/"));
  const sub = e8.fileNameAbsoluteP(fileName) ? fileName.slice(root.length) : undefined;
  let variables = variablesIn;
  try {
    for (const entry of classVars) {
      const key = entry[0];
      if (typeof key === "string") {
        if (sub !== undefined && sub.length >= key.length && sub.startsWith(key)) {
          variables = collectVariables(entry.slice(1).filter(Array.isArray) as e8.Value[][], root, variables, predicate);
        }
      } else if (predicate ? predicate(key) : key === null || key === false || (typeof key === "symbol" && e8.derivedModeP(e8.symbolName(key)))) {
        let alist = entry.slice(1);
        const subdirs = alist.find((e) => Array.isArray(e) && isSym(e[0], "subdirs"));
        if (subdirs !== undefined) alist = alist.filter((e) => e !== subdirs);
        const subdirsValue = subdirs === undefined ? undefined : pairOf(subdirs)?.[1];
        if (subdirs === undefined || truthy(subdirsValue) || root === asDirectory(e8.expandFileName(String(v("default-directory") ?? "")))) {
          variables = collectModeVariables(alist, variables);
        }
      }
    }
  } catch (e) {
    e8.message(`${String(v("dir-locals-file"))} error: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  return variables;
}

/** This buffer's directory-local variables, as (DIR . ALIST), as hack-dir-local--get-variables. */
function getDirLocalVariables(predicate?: (key: e8.Value) => boolean): [string, Pair[]] | undefined {
  if (!truthy(v("enable-local-variables")) || !truthy(v("enable-dir-local-variables"))) return undefined;
  const found = dirLocalsFindFile(e8.bufferFileName() ?? String(v("default-directory") ?? "~/"));
  let className: e8.Value | undefined;
  let dirName: string | undefined;
  if (typeof found === "string") {
    dirName = found;
    className = dirLocalsReadFromDir(found);
  } else if (Array.isArray(found)) {
    dirName = String(found[0]);
    className = found[1];
  }
  if (className === undefined || dirName === undefined) return undefined;
  return [dirName, collectVariables(classVariables(className), dirName, [], predicate)];
}
e8.defun("hack-dir-local--get-variables", () => {
  const got = getDirLocalVariables();
  return got === undefined ? null : [got[0], ...got[1]];
});

/**
 * Takes up this buffer's directory-local variables into
 * dir-local-variables-alist and file-local-variables-alist, asking about
 * unsafe ones, without setting them, as hack-dir-local-variables.
 */
export function hackDirLocalVariables(): void {
  let items: [string, Pair[]][] = [];
  if (truthy(v("enable-local-variables")) && truthy(v("enable-dir-local-variables"))) {
    // (DIR . ALIST) as E8 reads it: the directory, then the pairs.
    const item = (r: e8.Value[]): [string, Pair[]] => [String(r[0]), r.slice(1).map(pairOf).filter((p): p is Pair => p !== undefined)];
    for (const fn of list(v("hack-dir-local-get-variables-functions"))) {
      if (fn === sym("hack-dir-local--get-variables")) {
        const got = getDirLocalVariables();
        if (got !== undefined) items = [got, ...items];
        continue;
      }
      const result = (typeof fn === "function" ? fn() : e8.funcall(nameOf(fn))) as e8.Value;
      if (!Array.isArray(result) || result.length === 0) continue;
      if (typeof result[0] === "string") items = [item(result), ...items];
      else for (const r of result) if (Array.isArray(r) && typeof r[0] === "string") items = [item(r), ...items];
    }
  }
  // Nearest directory first, and a variable it sets left out of those further up.
  items = items.reverse().sort((a, b) => b[0].length - a[0].length);
  let seen: symbol[] = [];
  for (const item of items) {
    if (seen.length > 0) item[1] = item[1].filter((p) => !seen.includes(p[0]));
    seen = [...item[1].map((p) => p[0]).filter((s) => !["eval", "mode"].includes(e8.symbolName(s))), ...seen];
  }
  for (const [dirName, variables] of items) {
    if (variables.length === 0) continue;
    let dirAlist = list(v("dir-local-variables-alist")) as Pair[];
    for (const pair of variables) {
      if (e8.symbolName(pair[0]) === "coding") {
        e8.message("Coding cannot be specified by dir-locals");
        continue;
      }
      if (!["eval", "mode"].includes(e8.symbolName(pair[0]))) dirAlist = dirAlist.filter((p) => p[0] !== pair[0]);
      dirAlist = [pair, ...dirAlist];
    }
    e8.setVariable("dir-local-variables-alist", dirAlist);
    filterVariables(variables, dirName);
  }
}

/** Sets directory-local variables in a buffer with no file, from default-directory, as Dired's do, as hack-dir-local-variables-non-file-buffer. */
export function hackDirLocalVariablesNonFileBuffer(): void {
  try {
    hackDirLocalVariables();
  } catch (e) {
    e8.message(`Directory-local variables error: ${e instanceof Error ? e.message : String(e)}`);
  }
  applyVariables();
}

/** The dir-locals file a buffer's directory-local variables come from, or undefined, for files-x.ts. */
export function dirLocalsFileFor(file: string): string | e8.Value[] | undefined {
  return dirLocalsFindFile(file);
}
export { dirLocalsAllFiles };

e8.defun("hack-dir-local-variables", () => hackDirLocalVariables());
e8.defun("hack-dir-local-variables-non-file-buffer", () => hackDirLocalVariablesNonFileBuffer());
e8.defun("dir-locals-set-class-variables", (className: e8.Value, variables: e8.Value) => setClassVariables(className, list(variables)));
e8.defun("dir-locals-set-directory-class", (directory: string, className: e8.Value, mtime?: number) => setDirectoryClass(directory, className, mtime ?? null));
e8.defun("dir-locals-find-file", (file: string) => dirLocalsFindFile(file) ?? null);

e8.defun("hack-local-variables", (handleMode?: e8.Value, inhibitLocals?: e8.Value) =>
  hackLocalVariables(handleMode === undefined || handleMode === null ? null : handleMode === true ? true : "no-mode", truthy(inhibitLocals ?? null)) ?? null,
);
e8.defun("safe-local-variable-p", (variable: e8.Value, value: e8.Value) => safeLocalVariableP(sym(nameOf(variable)), value));
e8.defun("risky-local-variable-p", (variable: e8.Value) => riskyLocalVariableP(sym(nameOf(variable))));
e8.defun("hack-local-variables-apply", () => applyVariables());


/** The mode the file's name asks for, through auto-mode-alist. */
function modeFromFileName(): string | undefined {
  const file = e8.bufferFileName();
  const alist = e8.variable("auto-mode-alist");
  if (file === undefined || !Array.isArray(alist)) {
    return undefined;
  }
  for (const entry of alist) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      if (e8.stringMatch(entry[0], file) !== undefined) {
        return entry[1];
      }
    }
  }
  return undefined;
}

e8.defineHook("hack-local-variables-hook", "Run once a file's local variables are set, as major modes and editorconfig use to look at them.");

e8.defineCommand({
  name: "normal-mode",
  doc:
    "Choose the current buffer's major mode, as when its file is visited, and set the file's local variables.\n\n" +
    "A mode named on the first line, as in -*- text -*-, or in the Local Variables list comes first; then " +
    "auto-mode-alist, matched against the file name; otherwise Fundamental mode. Run as a command, it sets the " +
    "local variables whatever enable-local-variables says, asking about unsafe ones; visiting a file obeys it.",
  params: [{ name: "find-file", kind: "prefix" }],
  run: (findFile: e8.PrefixArg) => {
    const enable = findFile === null ? true : (v("enable-local-variables") ?? null);
    e8.letBind({ "enable-local-variables": enable }, () => {
      let mode: string | undefined;
      try {
        mode = [hackLocalVariables(true), modeFromFileName()].find((m) => m !== undefined && e8.commandExists(m));
      } catch (e) {
        e8.message(`File mode specification error: ${e instanceof Error ? e.message : String(e)}`);
      }
      // The mode runs its hooks, and then, for a file, hack-local-variables, as run-mode-hooks does.
      e8.call((mode ?? "fundamental-mode") as e8.CommandName);
    });
  },
});

// Saving, reverting and recovering files, after files.el. What touches the
// disk is native, as Emacs's fileio.c is: writing with a backup, reading
// back, auto-saving. Emacs's questions wait for an answer; here each one
// calls on with it.

e8.defineVariable({
  name: "require-final-newline",
  doc:
    "Whether saving adds a newline to a file that does not end in one: true adds it, false leaves the file as it is, " +
    '"ask" asks first. Text and programming modes set it from mode-require-final-newline.',
  value: false,
  local: true,
});

e8.defineVariable({
  name: "mode-require-final-newline",
  doc: "The value text and programming modes give require-final-newline in their buffers.",
  value: true,
});

e8.defineVariable({
  name: "revert-without-query",
  doc: "Files revert-buffer reverts without asking, if unmodified: a list of Emacs regular expressions matched against the file name.",
  value: [],
});

e8.defineHook("before-revert-hook", "Run before revert-buffer replaces the text with the file's.");
e8.defineHook("after-revert-hook", "Run after revert-buffer has reread the file.");

/** The buffer's file, or an error saying it has none. */
function visitedFile(message = "Buffer does not seem to be associated with any file"): string {
  const file = e8.bufferFileName();
  if (file === undefined) throw new Error(message);
  return file;
}

/** A file name with the home directory as ~, as Emacs's abbreviate-file-name. */
function abbreviate(file: string): string {
  const home = e8.expandFileName("~");
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

function nondirectory(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** Adds the newline require-final-newline asks for, as basic-save-buffer does before writing. */
function addFinalNewline(): void {
  const size = e8.bufferSize();
  const require = e8.variable("require-final-newline");
  if (size === 0 || require === false || require === null || e8.bufferText(size - 1, size) === "\n") return;
  if (require === true || require === "visit-save" || e8.yOrNP(`Buffer ${e8.bufferName()} does not end in newline.  Add one? `)) {
    const point = e8.point();
    e8.gotoChar(e8.pointMax());
    e8.insert("\n");
    e8.gotoChar(point);
  }
}

/** Writes the buffer, says so and runs the save hooks, as basic-save-buffer does once it may. */
function writeBuffer(file: string): void {
  e8.runHooks("before-save-hook");
  e8.writeVisitedFile();
  e8.message(`Wrote ${e8.bufferFileName() ?? file}`);
  e8.runHooks("after-save-hook");
}

/**
 * Saves the current buffer if it is modified, as Emacs's basic-save-buffer.
 * A file changed on disk since it was visited or saved is overwritten
 * only if you say so.
 */
function basicSaveBuffer(): void {
  const file = e8.bufferFileName();
  if (!e8.bufferModified()) {
    if (e8.calledInteractively()) e8.message("(No changes need to be saved)");
    return;
  }
  if (file === undefined) {
    // Emacs reads a file to save in; write-file reads one too.
    e8.callInteractively("write-file");
    return;
  }
  if (e8.visitedFileChanged() && !e8.yesOrNoP(`${nondirectory(file)} has changed since visited or saved.  Save anyway? `)) {
    e8.userError("Save not confirmed");
  }
  addFinalNewline();
  selectSafeCodingSystem();
  writeBuffer(file);
}

e8.defineCommand({
  name: "save-buffer",
  doc:
    "Save the current buffer to its file, if it has changed.\n\n" +
    "The first save in a session keeps the file as it was in name~ (see make-backup-files). If the file changed on disk " +
    "since you visited or saved it, you are asked before it is overwritten. A buffer with no file asks for one, as write-file does.",
  run: () => basicSaveBuffer(),
});

e8.defineCommand({
  name: "write-file",
  doc:
    "Write the current buffer to a file and visit that file instead.\n\n" +
    "A directory writes a file of the buffer's name in it. An existing file is overwritten only if you say so.",
  params: [{ name: "file", kind: "file", prompt: "Write file: " }],
  run: (input: string) => {
    let file = e8.expandFileName(input);
    if (input.endsWith("/")) file = `${file.replace(/\/$/, "")}/${e8.bufferName()}`;
    if (e8.calledInteractively() && e8.fileExists(file) && file !== e8.bufferFileName()) {
      if (!e8.yOrNP(`File ‘${file}’ exists; overwrite? `)) throw new Error("Canceled");
    }
    e8.setVisitedFileName(file);
    e8.setBufferModified(true);
    basicSaveBuffer();
  },
});

e8.defineCommand({
  name: "not-modified",
  doc: "Mark the current buffer as unmodified, not needing to be saved.\n\nWith a prefix argument, mark it as modified, so save-buffer will save it.",
  run: () => {
    const modified = e8.prefixArg() !== null;
    e8.message(modified ? "Modification-flag set" : "Modification-flag cleared");
    e8.setBufferModified(modified);
  },
});

/** Rereads the file into the buffer and chooses its mode again, as revert-buffer--default does once it may. */
function revertNow(): void {
  e8.runHooks("before-revert-hook");
  e8.revertToVisitedFile();
  e8.callWithPrefix(1, "normal-mode");
  e8.runHooks("after-revert-hook");
}


e8.defineVariable({
  name: "revert-buffer-function",
  doc: "The command revert-buffer runs instead of rereading the file, in buffers that set it, such as Dired's. Nil for the usual.",
  value: null,
});

/**
 * Reverts the buffer, asking first unless `noconfirm`, or the buffer is
 * unmodified and its file matches revert-without-query.
 */
function revertBuffer(noconfirm: boolean): void {
  // A buffer such as Dired's reverts itself, as its revert-buffer-function says.
  const own = e8.variable("revert-buffer-function");
  if (typeof own === "string" && e8.commandExists(own)) {
    e8.call(own as e8.CommandName);
    return;
  }
  const file = visitedFile();
  if (!e8.fileExists(file)) throw new Error(`File ${file} no longer exists!`);
  const modified = e8.bufferModified();
  const patterns = e8.variable("revert-without-query");
  const unasked = !modified && Array.isArray(patterns) && patterns.some((p) => typeof p === "string" && e8.stringMatch(p, file) !== undefined);
  const question = modified ? `Discard edits and reread from ${file}? ` : `Revert buffer from file ${file}? `;
  if (noconfirm || unasked || e8.yesOrNoP(question)) revertNow();
}

e8.defineCommand({
  name: "revert-buffer",
  doc:
    "Replace the buffer's text with its file's, after asking.\n\n" +
    "Point stays where the text is unchanged. The major mode is chosen again, as when visiting the file. The revert can be undone.",
  run: () => revertBuffer(false),
});

e8.defineCommand({
  name: "revert-buffer-quick",
  doc: "Revert the buffer from its file, asking only if it has unsaved changes.",
  run: () => {
    if (e8.bufferFileName() !== undefined && !e8.bufferModified()) {
      revertBuffer(true);
      e8.message("Reverted buffer");
    } else {
      revertBuffer(false);
    }
  },
});

e8.defineCommand({
  name: "recover-this-file",
  doc: "Replace the buffer's text with its auto-save file's, after asking: what was typed since the last save, before a crash.",
  run: () => e8.call("recover-file", visitedFile("This buffer is not visiting a file")),
});

e8.defineCommand({
  name: "recover-file",
  doc:
    "Visit a file, taking its text from its auto-save file, #name#, after asking.\n\n" +
    "The buffer is left modified; save it to keep what was recovered.",
  params: [{ name: "file", kind: "file", prompt: "Recover file: " }],
  run: (input: string) => {
    const file = e8.expandFileName(input);
    if (/^#.*#$/.test(nondirectory(file))) throw new Error(`${abbreviate(file)} is an auto-save file`);
    const auto = e8.autoSaveFileName(file);
    if (e8.fileExists(file) && !e8.fileExists(auto)) throw new Error(`Auto save file ${abbreviate(auto)} does not exist`);
    if (!e8.hasNewerAutoSave(file)) e8.userError(`Auto-save file ${abbreviate(auto)} not current`);
    for (;;) {
      const answer = e8.readAnswer(`Recover auto save file ${auto}? `, ["yes", "no", "diff"]);
      if (answer === "diff") {
        e8.message("E8 cannot show the differences yet");
        continue;
      }
      if (answer !== "yes") e8.userError("Recover-file canceled");
      e8.call("switch-to-buffer", e8.findFileNoselect(file));
      e8.recoverFromAutoSave();
      return;
    }
  },
});

e8.defineCommand({
  name: "auto-save-mode",
  doc: "Toggle auto-saving of the current buffer to #name# beside its file.\n\nWith a positive prefix argument, turn it on; with zero or a negative one, off.",
  run: () => {
    const arg = e8.prefixArg();
    const on = arg === null ? !e8.autoSaving() : e8.prefixNumericValue(arg) > 0;
    if (on && e8.bufferFileName() === undefined) throw new Error("Buffer does not seem to be associated with any file");
    e8.setAutoSave(on);
    e8.message(`Auto-save ${on ? "on" : "off"} (in this buffer)`);
  },
});

e8.defineCommand({
  name: "do-auto-save",
  doc: "Auto-save every buffer that has changed since it was last saved or auto-saved.",
  run: () => {
    e8.doAutoSave();
  },
});

/** The buffers save-some-buffers asks about: modified ones visiting files. */
function buffersNeedingSave(): string[] {
  return e8
    .bufferList()
    .filter((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName() !== undefined && e8.bufferModified()));
}

/**
 * Asks about saving each modified file buffer in turn, as Emacs's
 * save-some-buffers with map-y-or-n-p: y saves it, n skips it, ! saves the
 * rest, . saves it and stops, q stops. With `all`, saves them all without
 * asking.
 */
function saveSomeBuffers(all: boolean, interactive: boolean): void {
  const buffers = buffersNeedingSave();
  if (buffers.length === 0) {
    if (interactive) e8.message("(No files need saving)");
    return;
  }
  const save = (buffer: string) => e8.withCurrentBuffer(buffer, () => basicSaveBuffer());
  if (all) {
    buffers.forEach(save);
    return;
  }
  for (let k = 0; k < buffers.length; k++) {
    const buffer = buffers[k];
    const file = e8.withCurrentBuffer(buffer, () => e8.bufferFileName() ?? "");
    const what = buffer === nondirectory(file) || buffer.startsWith(`${nondirectory(file)}<`) ? `file ${file}` : `file ${file} (buffer ${buffer})`;
    const c = e8.readCharChoice(`Save ${what}? (y, n, !, ., q, C-r, C-f, d or C-h) `, "yn!.q ");
    if (c === "y" || c === " ") save(buffer);
    else if (c === "!") return buffers.slice(k).forEach(save);
    else if (c === ".") return save(buffer);
    else if (c !== "n") return;
  }
}

e8.defineCommand({
  name: "save-some-buffers",
  doc:
    "Save some modified file buffers, asking about each: y saves it, n skips it, ! saves all the rest, . saves it and stops, and q stops.\n\n" +
    "With a prefix argument, save them all without asking.",
  run: () => saveSomeBuffers(e8.prefixArg() !== null, e8.calledInteractively()),
});

e8.defineCommand({
  name: "save-buffers-kill-terminal",
  doc:
    "Offer to save each modified file buffer, then exit.\n\n" +
    "If any are left unsaved, you are asked whether to exit anyway. With a prefix argument, save them all without asking.",
  run: () => {
    saveSomeBuffers(e8.prefixArg() !== null, false);
    if (buffersNeedingSave().length > 0 && !e8.yesOrNoP("Modified buffers exist; exit anyway? ")) return;
    // Then, as save-buffers-kill-emacs does, about processes still running.
    const running = e8.processList().filter((p) => e8.processStatus(p) === "run" && e8.processQueryOnExitFlag(p));
    if (running.length > 0) {
      if (!e8.yesOrNoP("Active processes exist; kill them and exit anyway? ")) return;
      for (const p of running) e8.deleteProcess(p);
    }
    // Then whatever else packages ask about, as Org's clock does; one saying no keeps E8 running.
    if (!e8.runHookWithArgsUntilFailure("kill-emacs-query-functions")) return;
    e8.killEmacs();
  },
});

e8.defineHook("kill-emacs-query-functions", "Functions called before E8 exits from save-buffers-kill-terminal; if one returns false, it does not exit.");

// Reverting buffers when their files change, after autorevert.el, by
// looking every auto-revert-interval seconds.

e8.defineVariable({
  name: "auto-revert-interval",
  doc: "How many seconds between checks for files that changed, in buffers where auto-revert-mode or global-auto-revert-mode is on.",
  value: 5,
});

e8.defineVariable({
  name: "auto-revert-verbose",
  doc: "Whether reverting a buffer because its file changed says so.",
  value: true,
});

let autoRevertTimer: number | undefined;

/** Reverts each buffer that auto-reverts, is unmodified, and whose file changed. */
function autoRevertBuffers(): void {
  const global = e8.variable("global-auto-revert-mode") === true;
  for (const buffer of e8.bufferList()) {
    e8.withCurrentBuffer(buffer, () => {
      const file = e8.bufferFileName();
      if (file === undefined || (!global && e8.variable("auto-revert-mode") !== true)) return;
      if (e8.bufferModified() || !e8.visitedFileChanged() || !e8.fileExists(file)) return;
      revertNow();
      if (e8.variable("auto-revert-verbose") === true) e8.message(`Reverting buffer ‘${buffer}’`);
    });
  }
}

/** Starts checking files if any buffer auto-reverts, and stops when none does. */
function updateAutoRevertTimer(): void {
  const wanted =
    e8.variable("global-auto-revert-mode") === true ||
    e8.bufferList().some((b) => e8.withCurrentBuffer(b, () => e8.variable("auto-revert-mode") === true));
  if (wanted && autoRevertTimer === undefined) {
    const interval = Number(e8.variable("auto-revert-interval")) || 5;
    autoRevertTimer = e8.runWithTimer(interval, interval, autoRevertBuffers);
  } else if (!wanted && autoRevertTimer !== undefined) {
    e8.cancelTimer(autoRevertTimer);
    autoRevertTimer = undefined;
  }
}

e8.defineMinorMode({
  name: "auto-revert-mode",
  lighter: " ARev",
  doc: "Revert the buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

e8.defineMinorMode({
  name: "global-auto-revert-mode",
  global: true,
  doc: "Revert every file buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

// Managing files, after the commands of files.el and fileio.c.

/** Whether to go ahead where `file` exists: asked when typed, refused from code, as `ok-if-already-exists` 0 does. */
function confirmOverwrite(file: string, verb: string): void {
  if (!e8.fileExists(file)) return;
  const exists = `File already exists: ${e8.expandFileName(file)}`;
  if (!e8.calledInteractively()) throw new Error(exists);
  if (!e8.yesOrNoP(`File ${e8.abbreviateFileName(e8.expandFileName(file))} already exists; ${verb} to it anyway? `)) throw new Error(exists);
}

/** Where a copy or rename of `from` to `to` lands: inside `to` if it ends in a slash. */
const targetName = (from: string, to: string): string =>
  to.endsWith("/") ? to + e8.fileNameNondirectory(e8.directoryFileName(from)) : to;

const trashing = (): boolean => {
  const on = e8.variable("delete-by-moving-to-trash");
  return on !== null && on !== false && e8.prefixArg() === null;
};

e8.defineCommand({
  name: "copy-file",
  doc:
    "Copy a file. A name ending in a slash copies it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error. " +
    "With a prefix argument, the copy keeps the file's modification time.",
  params: [
    { name: "file", kind: "file", prompt: "Copy file: " },
    { name: "newname", kind: "file", prompt: (file) => `Copy ${e8.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    const keepTime = e8.prefixArg() !== null;
    confirmOverwrite(targetName(file, newname), "copy");
    e8.copyFile(file, newname, { okIfExists: true, keepTime });
  },
});

e8.defineCommand({
  name: "rename-file",
  doc:
    "Rename a file or directory. A name ending in a slash moves it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error.",
  params: [
    { name: "file", kind: "file", prompt: "Rename file: " },
    { name: "newname", kind: "file", prompt: (file) => `Rename ${e8.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    confirmOverwrite(targetName(file, newname), "rename");
    e8.renameFile(file, newname, { okIfExists: true });
  },
});

e8.defineCommand({
  name: "delete-file",
  doc:
    "Delete a file. With delete-by-moving-to-trash, on in E8, it goes to the trash, from where it can be put back.\n\n" +
    "With a prefix argument, delete it for good instead.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => trashing() ? "Move file to trash: " : "Delete file: ",
  }],
  run: (file: string) => e8.deleteFile(file, { trash: trashing() }),
});

e8.defineCommand({
  name: "make-directory",
  doc: "Make a directory, and any directories above it that are missing.",
  params: [{ name: "dir", kind: "file", prompt: "Make directory: " }],
  run: (dir: string) => e8.makeDirectory(dir, { parents: true }),
});

e8.defineCommand({
  name: "delete-directory",
  doc:
    "Delete a directory, asking first if it has files in it. With delete-by-moving-to-trash, on in E8, " +
    "it goes to the trash.\n\nWith a prefix argument, delete it for good instead.",
  params: [{
    name: "dir",
    kind: "file",
    prompt: () => trashing() ? "Move directory to trash: " : "Delete directory: ",
  }],
  run: (dir: string) => {
    const trash = trashing();
    const empty = e8.directoryFiles(dir).length <= 2;
    if (empty) return e8.deleteDirectory(dir, { trash });
    if (!e8.calledInteractively()) return e8.deleteDirectory(dir, { trash });
    const verb = trash ? "trash" : "delete";
    // As in Emacs, no still tries, and fails as the directory is not empty.
    const yes = e8.yOrNP(`Directory ${e8.abbreviateFileName(e8.directoryFileName(e8.expandFileName(dir)))} is not empty, really ${verb}? `);
    e8.deleteDirectory(dir, { recursive: yes, trash });
  },
});

e8.defineCommand({
  name: "copy-directory",
  doc: "Copy a directory and what it holds: into the new name if that is a directory already, else as it.",
  params: [
    { name: "directory", kind: "file", prompt: "Copy directory: " },
    { name: "newname", kind: "file", prompt: (dir) => `Copy directory ${e8.abbreviateFileName(dir)} to: ` },
  ],
  run: (directory: string, newname: string) => {
    e8.copyDirectory(directory, newname, { keepTime: e8.prefixArg() !== null });
  },
});

e8.defineCommand({
  name: "read-only-mode",
  doc:
    "Make the buffer read-only, or editable again.\n\n" +
    "A buffer visiting a file that cannot be written starts read-only. With a prefix argument, " +
    "a positive number makes it read-only and zero or less editable.",
  run: () => {
    const arg = e8.prefixArg();
    const on = arg === null ? !e8.bufferReadOnly() : e8.prefixNumericValue(arg) > 0;
    e8.setReadOnly(on);
    if (e8.calledInteractively()) e8.message(`Read-Only mode ${on ? "enabled" : "disabled"} in current buffer`);
  },
});

e8.defineCommand({
  name: "find-alternate-file",
  doc:
    "Visit another file in place of the current buffer's, which is killed.\n\n" +
    "The prompt starts with the current file's name, for visiting one like it. A buffer with unsaved changes " +
    "is killed only once you say so.",
  params: [{
    name: "file",
    kind: "file",
    prompt: "Find alternate file: ",
    initial: () => {
      const file = e8.bufferFileName();
      return file === undefined ? e8.abbreviateFileName(e8.fileNameAsDirectory(e8.expandFileName("."))) : e8.abbreviateFileName(file);
    },
  }],
  run: (file: string) => {
    const old = e8.bufferName();
    const replace = () => {
      // The old buffer gives up its name and file first, so the same file
      // is read afresh, as files.el renames it " **lose**".
      const oldFile = e8.bufferFileName();
      e8.setBufferModified(false);
      e8.setVisitedFileName(null);
      const lose = e8.generateNewBufferName(" **lose**");
      e8.call("rename-buffer", lose);
      try {
        e8.call("find-file", file);
      } finally {
        if (e8.bufferName() === lose) {
          // Visiting failed: the old buffer is as it was.
          e8.call("rename-buffer", old);
          if (oldFile !== undefined) e8.setVisitedFileName(oldFile, { alongWithFile: true });
        }
      }
      if (e8.bufferName() !== lose) e8.call("kill-buffer", lose);
    };
    if (e8.bufferModified() && e8.bufferFileName() !== undefined) {
      if (!e8.calledInteractively()) throw new Error(`Buffer ${old} modified`);
      if (!e8.yesOrNoP(`Buffer \u2018${old}\u2019 modified; kill anyway? `)) throw new Error("Aborted");
    }
    replace();
  },
});

e8.defineCommand({
  name: "rename-visited-file",
  doc:
    "Rename the file the buffer visits, and visit it under its new name.\n\n" +
    "In a buffer visiting no file, set the file it visits instead, as set-visited-file-name does.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => e8.bufferFileName() === undefined ? "Set visited file name: " : "Rename visited file to: ",
  }],
  run: (input: string) => {
    const old = e8.bufferFileName();
    const file = e8.expandFileName(targetName(old ?? e8.bufferName(), input));
    const along = old !== undefined && e8.fileExists(old);
    if (along) e8.renameFile(old, file);
    e8.setVisitedFileName(file, { alongWithFile: along });
  },
});

e8.bindKey("C-x C-q", "read-only-mode");
e8.bindKey("C-x C-v", "find-alternate-file");
e8.bindKey("C-x C-s", "save-buffer");
e8.bindKey("C-x C-w", "write-file");
e8.bindKey("C-x s", "save-some-buffers");
e8.bindKey("C-x C-c", "save-buffers-kill-terminal");
e8.bindKey("C-x x g", "revert-buffer-quick");
e8.bindKey("M-~", "not-modified");

// Inserting and writing parts of files, after files.el's insert-file and
// append-to-file and fileio.c's write-region command.

const insertFile = e8.defineCommand({
  name: "insert-file",
  doc: "Insert a file's text after point, leaving point before it and the mark after it.",
  params: [{ name: "file", kind: "file", prompt: "Insert file: " }],
  run: (file) => {
    // The name as it was given, as insert-file-1 signals it.
    if (e8.fileDirectoryP(file)) {
      e8.signal("file-error", `Opening input file: Is a directory, ${file}`, ["Opening input file", "Is a directory", file]);
    }
    const [, inserted] = e8.insertFileContents(file);
    e8.pushMark(e8.point() + inserted);
    e8.message("Mark set");
  },
});
e8.bindKey("C-x i", insertFile);

e8.defineCommand({
  name: "write-region",
  doc:
    "Write the region to a file, as it is, the buffer still visiting its own.\n\n" +
    "A file that exists is overwritten only if you say so.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "file", kind: "file", prompt: "Write region to file: " },
  ],
  run: async (start, end, file) => {
    const name = e8.expandFileName(file);
    // As write-region's interactive MUSTBENEW, as barf_or_query_if_file_exists asks.
    if (e8.calledInteractively() && e8.fileExistsP(name)) {
      if (!(await e8.yesOrNoP(`File ${name} already exists; overwrite anyway? `))) {
        e8.signal("file-already-exists", `File already exists: ${name}`, ["File already exists", name]);
      }
    }
    e8.writeRegion(start, end, name);
  },
});

e8.defineCommand({
  name: "append-to-file",
  doc: "Add the region to the end of a file.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "file", kind: "file", prompt: "Append to file: " },
  ],
  run: (start, end, file) => e8.writeRegion(start, end, file, { append: true }),
});

// Killing several buffers, after files.el: kill-some-buffers asks about
// each one, kill-matching-buffers about those whose names match.

/** Kills a buffer if the answer is yes, as kill-buffer-ask. */
async function killBufferAsk(buffer: string): Promise<void> {
  const modified = e8.withCurrentBuffer(buffer, () => e8.bufferModified());
  if (await e8.yesOrNoP(`Buffer ${buffer} ${modified ? "HAS BEEN EDITED" : "is unmodified"}.  Kill? `)) e8.call("kill-buffer", buffer);
}

e8.defineCommand({
  name: "kill-some-buffers",
  doc: "Ask about each buffer whether to kill it, saying whether it has been edited; buffers whose names start with a space are left.",
  run: async () => {
    for (const buffer of e8.bufferList()) {
      if (buffer === "" || buffer.startsWith(" ") || !e8.getBuffer(buffer)) continue;
      await killBufferAsk(buffer);
    }
  },
});

for (const [name, doc, ask] of [
  ["kill-matching-buffers", "Kill the buffers whose names match a regexp, asking about each; with a prefix argument, those whose names start with a space too.", true],
  ["kill-matching-buffers-no-ask", "Kill the buffers whose names match a regexp, without asking; with a prefix argument, those whose names start with a space too.", false],
] as const) {
  e8.defineCommand({
    name,
    doc,
    params: [
      { name: "regexp", kind: "string", prompt: "Kill buffers matching this regular expression: " },
      { name: "internal", kind: "prefix" },
    ],
    run: async (regexp: string, internal: e8.PrefixArg) => {
      for (const buffer of e8.bufferList()) {
        if (buffer === "" || (internal === null && buffer.startsWith(" ")) || !e8.getBuffer(buffer)) continue;
        if (e8.stringMatch(regexp, buffer) === undefined) continue;
        if (ask) await killBufferAsk(buffer);
        else e8.call("kill-buffer", buffer);
      }
    },
  });
}

/**
 * A file's name relative to a directory, default-directory unless given,
 * going up with ".." where it must, as file-relative-name.
 */
export function fileRelativeName(file: string, directory?: string): string {
  const dir = e8.expandFileName(directory ?? String(e8.variable("default-directory") ?? "."));
  const parts = (path: string) => path.split("/").filter((p) => p !== "");
  const [from, to] = [parts(dir), parts(e8.expandFileName(file))];
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const rel = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
  return rel === "" ? "." : rel;
}

/**
 * The buffer visiting a file, by its name or, failing that, its true name,
 * so a link or another spelling of the same file finds it, as
 * find-buffer-visiting.
 */
export function findBufferVisiting(file: string): string | undefined {
  const name = e8.expandFileName(file);
  const visited = (b: string) => e8.withCurrentBuffer(b, () => e8.bufferFileName());
  const exact = e8.bufferList().find((b) => visited(b) === name);
  if (exact !== undefined) return exact;
  const truename = e8.fileTruename(name);
  return e8.bufferList().find((b) => {
    const f = visited(b);
    return f !== undefined && e8.fileTruename(f) === truename;
  });
}
