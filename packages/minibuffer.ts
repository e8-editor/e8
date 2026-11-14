// Completing the text at point, after Emacs's minibuffer.el: C-M-i runs
// completion-at-point, which asks completion-at-point-functions for what
// could complete the text before point, as a language server or a mode
// gives it. One completion, or the part all share, is put in at once; for
// several, the minibuffer asks which, as completion-in-region would show
// them, with what is typed so far as its input.


e8.defineHook(
  "completion-at-point-functions",
  "Functions that say what completes the text at point: each gives [start, end, completions] or nil, the first that gives one winning.",
);

/** The part strings share at their start. */
function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

/** Puts a completion in place of the text from `start` to `end`, as completion-in-region does. */
function replace(start: number, end: number, text: string): void {
  e8.deleteRegion(start, end);
  e8.gotoChar(start);
  e8.insert(text);
}

/**
 * Completes the text from `start` to `end` from `collection`, as
 * completion-in-region: a sole match goes in; the part all matches share
 * goes in if it is longer; otherwise the minibuffer asks.
 */
export function completionInRegion(start: number, end: number, collection: string[]): boolean {
  const typed = e8.bufferText(start, end);
  const matches = collection.filter((c) => c.startsWith(typed));
  const candidates = matches.length > 0 ? matches : collection;
  if (candidates.length === 0) {
    e8.message("No match");
    return false;
  }
  if (candidates.length === 1) {
    replace(start, end, candidates[0]);
    if (candidates[0] === typed) e8.message("Sole completion");
    return true;
  }
  const prefix = commonPrefix(candidates);
  if (matches.length > 0 && prefix.length > typed.length) {
    replace(start, end, prefix);
    return true;
  }
  const chosen = e8.completingRead("Complete: ", candidates, { initial: matches.length > 0 ? typed : "" });
  if (chosen !== "") replace(start, end, chosen);
  return true;
}

e8.defineCommand({
  name: "completion-at-point",
  doc:
    "Complete the text at point, from what completion-at-point-functions give: one completion goes in, or the part they share; " +
    "with several, the minibuffer asks which.",
  run: () => {
    const found = e8.runHookWithArgsUntilSuccess("completion-at-point-functions");
    if (!Array.isArray(found) || found.length < 3) {
      e8.message("No completions at point");
      return;
    }
    const [start, end, collection] = found as [number, number, e8.Value];
    const table = typeof collection === "function" ? (collection as unknown as () => string[])() : collection;
    completionInRegion(start, end, Array.isArray(table) ? table.map(String) : []);
  },
});

e8.defalias("complete-symbol", "completion-at-point");
e8.bindKey("C-M-i", "completion-at-point");


// Completion for scripts that show it their own way, as vertico does: the
// open prompt's completions in each style, styles that packages add, as
// orderless does to completion-styles-alist, and the prompt's metadata,
// as completion-metadata gives it.

e8.defineVariable({
  name: "completion-styles-alist",
  doc: "The completion styles there are, as [name, doc] pairs: those E8 has built in and those packages add with defineCompletionStyle.",
  value: [
    ["basic", "Completion of the prefix before point and the suffix after point."],
    ["partial-completion", "Completion of multiple words, each one taken as a prefix."],
    ["substring", "Completion of the string taken as a substring."],
    ["flex", "Completion of an in-order subset of characters."],
    ["emacs22", "Prefix completion that only operates on the text before point."],
  ],
});

/** The open prompt's input, split as completion-boundaries splits it, with what it completes against. */
export interface CompletionField {
  base: string;
  before: string;
  after: string;
  suffix: string;
  names: string[];
}

/** What a completion style finds: the matches, and how to highlight one, as completion-lazy-hilit-fn. */
export interface StyleMatches {
  completions: string[];
  hilit?: (candidate: string) => string | e8.PropertizedString;
}

/** A completion style a package adds, as an entry of completion-styles-alist. */
export interface CompletionStyle {
  doc: string;
  /** The names the field matches, as the style's all-completions function. */
  all: (field: CompletionField, ignoreCase: boolean) => StyleMatches | undefined;
}

const scriptStyles = new Map<string, CompletionStyle>();

/** Adds a completion style, for completion-styles to name, as an entry of completion-styles-alist. */
export function defineCompletionStyle(name: string, style: CompletionStyle): void {
  scriptStyles.set(name, style);
  const alist = e8.variable("completion-styles-alist");
  const entries = Array.isArray(alist) ? (alist as e8.Value[][]).filter((e) => e[0] !== name) : [];
  e8.setDefault("completion-styles-alist", [...entries, [name, style.doc]]);
}

/** The metadata of a completion table, as Emacs's completion metadata: what kind of things it completes and how to show them. */
export interface CompletionMetadata {
  category?: string;
  /** Text to show after a candidate. */
  annotationFunction?: (candidate: string) => string | e8.PropertizedString | undefined;
  /** Each candidate with text to show before and after it, as [candidate, prefix, suffix]. */
  affixationFunction?: (candidates: string[]) => [string, string | e8.PropertizedString, string | e8.PropertizedString][];
  /** A candidate's group title, or with `transform` the candidate as shown in its group. */
  groupFunction?: (candidate: string, transform: boolean) => string | undefined;
  /** How to order the candidates for showing them. */
  displaySortFunction?: (candidates: string[]) => string[];
  cycleSortFunction?: (candidates: string[]) => string[];
  /** How much of the input completion leaves alone, as a table's completion-boundaries: the rest is matched against the candidates. */
  boundaries?: (input: string) => number;
}

/** The metadata each open prompt's caller gave, by minibuffer depth. */
const metadataByDepth = new Map<number, CompletionMetadata>();

/**
 * Reads with completion, as completingRead does, the table's metadata
 * given too, as a completion table gives Emacs's completing-read its
 * metadata: annotations, groups, a sort.
 */
export function completingReadWithMetadata(
  prompt: string,
  collection: e8.CompletionTable,
  options: e8.CompletingReadOptions & { metadata?: CompletionMetadata } = {},
): string {
  const { metadata, ...rest } = options;
  const depth = e8.minibufferDepth() + 1;
  const old = metadataByDepth.get(depth);
  if (metadata) metadataByDepth.set(depth, { ...metadata, category: metadata.category ?? rest.category });
  try {
    return e8.completingRead(prompt, collection, { ...rest, category: rest.category ?? metadata?.category });
  } finally {
    if (old) metadataByDepth.set(depth, old);
    else metadataByDepth.delete(depth);
  }
}

/** A property of the open prompt's metadata, as completion-metadata-get: marginalia advises it to give annotations by category. */
export function completionMetadataGet<K extends keyof CompletionMetadata>(prop: K): CompletionMetadata[K] | undefined {
  return e8.funcall("completion-metadata-get", prop) as CompletionMetadata[K] | undefined;
}

e8.defun("completion-metadata-get", (prop: string) => {
  const own = metadataByDepth.get(e8.minibufferDepth());
  if (prop === "category") return own?.category ?? e8.minibufferInfo()?.category ?? undefined;
  return own?.[prop as keyof CompletionMetadata];
});

/** Highlights the part of CANDIDATE a built-in style matched, in completions-common-part, as completion-hilit-commonality does. */
function builtinHilit(style: string, field: CompletionField, ignoreCase: boolean): ((candidate: string) => string | e8.PropertizedString) | undefined {
  const typed = field.before;
  if (typed === "") return undefined;
  const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  return (candidate) => {
    const at = style === "substring" ? fold(candidate).indexOf(fold(typed)) : fold(candidate).startsWith(fold(typed)) ? 0 : -1;
    if (at < 0) return candidate;
    return e8.concat(candidate.slice(0, at), e8.propertize(candidate.slice(at, at + typed.length), { face: "completions-common-part" }), candidate.slice(at + typed.length));
  };
}

/**
 * The open prompt's completions in the first of its styles that finds any,
 * as completion-all-completions, with the base they go after and how to
 * highlight them; undefined with no prompt that completes.
 */
export function completionAllCompletions(point?: number): (StyleMatches & { base: string; style?: string; field: CompletionField }) | undefined {
  let field = e8.minibufferCompletionField(point);
  if (!field) return undefined;
  const boundaries = completionMetadataGet("boundaries");
  if (boundaries) {
    const whole = field.before + field.after;
    const n = Math.min(boundaries(whole), whole.length);
    const cut = Math.min(n, field.before.length);
    field = { ...field, base: field.base + whole.slice(0, n), before: field.before.slice(cut), after: n > field.before.length ? field.after.slice(n - field.before.length) : field.after };
  }
  const ignoreCase = e8.minibufferInfo()?.ignoreCase ?? false;
  for (const style of e8.completionStyles()) {
    const own = scriptStyles.get(style);
    const found: StyleMatches | undefined = own
      ? own.all(field, ignoreCase)
      : (() => {
          const completions = e8.completionAllInStyle(style, field.before, field.after, field.names, ignoreCase);
          return completions ? { completions, hilit: builtinHilit(style, field, ignoreCase) } : undefined;
        })();
    if (found && found.completions.length > 0) return { ...found, base: field.base, style, field };
  }
  return { completions: [], base: field.base, field };
}

/** Whether INPUT is an answer the open prompt takes, as test-completion: the part after the table's boundaries one of its names. */
export function testCompletion(input: string): boolean {
  const boundaries = completionMetadataGet("boundaries");
  return e8.testCompletion(boundaries ? input.slice(Math.min(boundaries(input), input.length)) : input);
}

// --- Completing buffer names and reading a variable, as minibuf.c does (ADR 0083)

/**
 * Completes `string` against the buffers' names, as Emacs's
 * internal-complete-buffer, the table read-buffer completes against:
 * with `flag` nil, the longest text all the matches start with, true when
 * `string` is the only match itself and nil when none matches, as
 * try-completion; with true, the matches, as all-completions, leaving out
 * the buffers whose names start with a space for empty input unless they
 * are all there is; with "lambda", whether `string` is a buffer's name, as
 * test-completion; with "metadata", the table's category. `predicate`, if
 * given, is called with each buffer as a name and the buffer, as
 * `[name, buffer]`, as Emacs passes the buffer list's entries.
 */
export function internalCompleteBuffer(string: string, predicate: unknown, flag: unknown): e8.Value {
  if (flag === "metadata") return ["metadata", ["category", "buffer"], ["cycle-sort-function", "identity"]];
  const fold = truthyValue(e8.variable("completion-ignore-case"));
  const norm = (s: string) => (fold ? s.toLowerCase() : s);
  const all = e8.bufferList();
  const accepts = (name: string) =>
    predicate === undefined || predicate === null || predicate === false || truthyValue(e8.funcall(predicate as string, [name, e8.getBuffer(name)]));
  const matches = all.filter((name) => norm(name).startsWith(norm(string)) && accepts(name));
  if (flag === "lambda") return matches.some((name) => norm(name) === norm(string));
  if (flag === true) {
    if (string.length > 0) return matches;
    const shown = matches.filter((name) => !name.startsWith(" "));
    // Only buffers whose names start with a space, and all of them: none is left out.
    return shown.length === 0 && matches.length === all.length ? matches : shown;
  }
  if (flag !== undefined && flag !== null && flag !== false) return null;
  return tryCompletionOf(string, matches, fold);
}

/**
 * The longest text the matches all start with, as Emacs's try-completion
 * works it out from them: true for `string` itself as the only match, and,
 * folding case, the case of a match exact but for case, else of one that
 * keeps the case typed, and what was typed when nothing is added.
 */
function tryCompletionOf(string: string, matches: string[], fold: boolean): string | boolean | null {
  const chars = (s: string) => [...s];
  const same = (a: string, b: string, ignoreCase: boolean) => a === b || (ignoreCase && a.toLowerCase() === b.toLowerCase());
  // How many characters two strings agree on, from the start, up to `n`.
  const agree = (a: string[], b: string[], n: number, ignoreCase: boolean) => {
    let i = 0;
    while (i < n && same(a[i], b[i], ignoreCase)) i++;
    return i;
  };
  const typed = chars(string);
  const keepsCase = (s: string[]) => s.length >= typed.length && agree(s, typed, typed.length, false) === typed.length;
  let best: string[] | undefined;
  let bestSize = 0;
  let count = 0;
  for (const match of matches) {
    const m = chars(match);
    if (best === undefined) {
      best = m;
      bestSize = m.length;
      count = 1;
      continue;
    }
    const compare = Math.min(bestSize, m.length);
    const size = agree(best, m, compare, fold);
    const old = best;
    if (fold) {
      const exact = size === m.length;
      if ((exact && size < best.length) || (exact === (size === best.length) && keepsCase(m) && !keepsCase(best))) best = m;
    }
    // The same string is not counted twice.
    if (bestSize !== m.length || bestSize !== size || (fold && agree(old, m, compare, false) !== compare)) count += count <= 1 ? 1 : 0;
    bestSize = size;
  }
  if (best === undefined) return null;
  if (fold && bestSize === typed.length && best.length > bestSize) return string;
  if (count === 1 && best.join("") === string) return true;
  return best.slice(0, bestSize).join("");
}
e8.defun("internal-complete-buffer", internalCompleteBuffer);

/** Whether a Lisp value is true, nil and false being false. */
function truthyValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * Reads a variable's name in the minibuffer and returns it, as Emacs's
 * read-variable: completing against the variables, one of which must be
 * chosen, with `defaultValue`, or the first of a list of them, for empty
 * input. Emacs offers only user options, which E8 does not tell apart, so
 * every variable is offered.
 */
export function readVariable(prompt: string, defaultValue?: string | string[] | null): string {
  const first = Array.isArray(defaultValue) ? defaultValue[0] : defaultValue;
  return e8.completingRead(prompt, [...e8.variableNames()].sort(), {
    requireMatch: true,
    history: "custom-variable-history",
    ...(first ? { default: first } : {}),
  });
}
e8.defun("read-variable", readVariable);
e8.defineVariable({ name: "custom-variable-history", doc: "Variable names read-variable was answered with, newest first.", value: [] });
