import { applyOnRegion } from "ansi-color";
import { PerBuffer, readPasswd, regexpQuote } from "subr";
import { isearchSearchFunDefault, isearchMessage, isearchMessagePrefix } from "isearch";

// Command interpreters in a buffer, after Emacs's comint.el: a program on
// a pseudo-terminal, its output marked as the `output` field and its prompt
// left for you to type after, input sent with RET and kept in a history
// (M-p, M-n), and the subjob signals on C-c C-c, C-c C-z and C-c C-\.
// Modes for shells and REPLs, as shell.ts's shell-mode, derive from it.

/** Emacs 30's comint-password-prompt-regexp, as it builds it from password-word-equivalents. */
const PASSWORD_PROMPT =
  "\\(^ *\\|\\( SMB\\|'s\\|Bad\\|C\\(?:VS\\|urrent\\)\\|Enter\\(?: \\(?:Auth\\|\\(?:sam\\|th\\)e\\)\\)?\\|Kerberos\\|LDAP\\|New\\|Old\\|PEM\\|Re\\(?:peat\\|type\\)\\|SUDO\\|UNIX\\|Verify\\|\\[sudo]\\|doas\\|enter\\(?: \\(?:auth\\|\\(?:sam\\|th\\)e\\)\\)?\\|login\\|new\\|old\\) +.*\\)\\(?:\\(?:adgangskode\\|contrase\\(?:\\(?:ny\\|ñ\\)a\\)\\|decryption key\\|encryption key\\|geslo\\|h\\(?:\\(?:asł\\|esl\\)o\\)\\|iphasiwedi\\|jelszó\\|l\\(?:ozinka\\|ösenord\\)\\|m\\(?:ot de passe\\|ật khẩu\\)\\|p\\(?:a\\(?:rola\\|s\\(?:ahitza\\|s\\(?: phrase\\|code\\|ord\\|phrase\\|wor[dt]\\)\\|vorto\\)\\)\\|in\\)\\|s\\(?:alasana\\|enha\\|laptažodis\\)\\|wachtwoord\\|лозинка\\|пароль\\|ססמה\\|كلمة السر\\|गुप्तशब्द\\|शब्दकूट\\|গুপ্তশব্দ\\|পাসওয়ার্ড\\|ਪਾਸਵਰਡ\\|પાસવર્ડ\\|ପ୍ରବେଶ ସଙ୍କେତ\\|கடவுச்சொல்\\|సంకేతపదము\\|ಗುಪ್ತಪದ\\|അടയാളവാക്ക്\\|රහස්පදය\\|ពាក្យសម្ងាត់\\|パスワード\\|密[码碼]\\|암호\\)\\|Response\\)\\(?:\\(?:, try\\)? *again\\| (empty for no passphrase)\\| (again)\\)?\\(?: [[:alpha:]]+ .+\\)?[[:blank:]]*[:：﹕︓៖][[:space:]]*\\'\\|^Enter encryption key: (repeat) *\\'\\|^([^)@ \t\n]+@[^)@ \t\n]+) Password: *\\'";

for (const [name, doc, value, local] of [
  ["comint-input-ring-size", "How many inputs a comint buffer keeps for M-p and M-n.", 500, false],
  ["comint-input-ignoredups", "Whether an input the same as the last one is left out of the history.", false, false],
  ["comint-prompt-read-only", "Whether the prompt is read-only, so it cannot be deleted by accident.", false, false],
  ["comint-eol-on-send", "Whether RET moves to the end of the input before sending it.", true, false],
  ["comint-process-echoes", "Whether the program echoes its input, which RET then takes out of its output.", false, true],
  ["comint-preoutput-filter-functions", "Functions each piece of output goes through before it is inserted; each returns the text to insert.", [], true],
  ["comint-password-prompt-regexp", "An Emacs regexp matching a program's prompts for a password, which comint then reads without showing it.", PASSWORD_PROMPT, false],
  ["comint-input-ring-file-name", "The file comint-read-input-ring reads the history from and comint-write-input-ring writes it to, or nil for none.", null, true],
  ["comint-input-ring-separator", "The regexp between inputs in the history file.", "\n", false],
  ["comint-input-history-ignore", "A regexp for entries of the history file to leave out.", "^#", false],
  ["comint-input-ring-file-prefix", "A regexp for what to skip at the start of each entry of the history file, such as zsh's time stamps.", null, true],
  ["comint-move-point-for-matching-input", "Where C-c M-r and C-c M-s leave point: after-input where it was, end-of-line at the end.", "after-input", false],
  ["comint-terminfo-terminal", "The terminal comint programs are told they run on, as TERM.", "dumb", false],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value, local });
}

/** What each comint buffer keeps: its input history and where it stands in it, and its markers. */
interface State {
  ring: string[];
  /** Where M-p and M-n are in the history, or undefined before the first. */
  index: number | undefined;
  /** What was typed before M-p, put back when going past the newest. */
  stored: string | undefined;
  /** The input C-c M-r and C-c M-s search the history for. */
  matching: string;
  lastInputStart: e8.Marker;
  lastInputEnd: e8.Marker;
  lastOutputStart: e8.Marker;
}

const states = new PerBuffer<State>();

function state(buffer = e8.bufferName()): State {
  let s = states.get(buffer);
  if (s === undefined) {
    s = {
      ring: [],
      index: undefined,
      stored: undefined,
      matching: "",
      lastInputStart: e8.makeMarker(e8.pointMax()),
      lastInputEnd: e8.makeMarker(e8.pointMax()),
      lastOutputStart: e8.makeMarker(e8.pointMax()),
    };
    states.set(buffer, s);
  }
  return s;
}

const nil = (v: unknown) => v === null || v === undefined || v === false;

/** The current buffer's process, or the error comint gives without one. */
function bufferProcess(): string {
  const p = e8.getBufferProcess(e8.bufferName());
  if (p === undefined) throw new Error("Current buffer has no process");
  return p;
}

const processMark = (p: string): number => e8.markerPosition(e8.processMark(p)!)!;

const PROMPT_REAR_NONSTICKY = ["field", "inhibit-line-move-field-capture", "read-only", "font-lock-face", "insert-in-front-hooks"];

/** Marks text as the program's output, the `output` field, as comint--mark-as-output. */
function markAsOutput(beg: number, end: number): void {
  if (beg >= end) return;
  e8.withSilentModifications(() => {
    for (const [name, value] of [
      ["field", Symbol.for("output")],
      ["inhibit-line-move-field-capture", true],
      ["rear-nonsticky", PROMPT_REAR_NONSTICKY],
      ["front-sticky", ["field", "inhibit-line-move-field-capture"]],
    ] as const) {
      e8.putTextProperty(beg, end, name, value as e8.Value);
    }
  });
}

/**
 * Carriage returns delete back to the start of the line and backspaces the
 * character before, CR LF becoming LF, as a terminal shows them, in
 * output from start to end, as comint-carriage-motion.
 */
function carriageMotion(start: number, end: number): void {
  const text = e8.bufferText(start, end);
  if (!/[\r\b]/.test(text)) return;
  e8.letBind({ "inhibit-read-only": true, "inhibit-field-text-motion": true }, () => {
    const endMarker = e8.makeMarker(end);
    let lbeg = e8.lineBeginningPosition(start);
    let p = start;
    while (p < e8.markerPosition(endMarker)!) {
      const c = e8.bufferText(p, p + 1);
      if (c === "\b") {
        e8.deleteRegion(p, p + 1);
        if (p > lbeg) {
          e8.deleteRegion(p - 1, p);
          p--;
        }
      } else if (c === "\n") {
        p++;
        lbeg = p;
      } else if (c === "\r") {
        e8.deleteRegion(p, p + 1);
        // CR LF is a line's end; a CR alone goes back to the line's start.
        if (e8.bufferText(p, p + 1) !== "\n") {
          e8.deleteRegion(lbeg, p);
          p = lbeg;
        }
      } else {
        p++;
      }
    }
    e8.deleteMarker(endMarker);
  });
}

/** Moves the windows showing a buffer whose point is at `at` to `to`, as window-point-insertion-type t does. */
function advanceWindowPoints(buffer: string, at: number, to: number): void {
  for (const w of e8.windowList()) {
    if (e8.windowBuffer(w) === buffer && e8.windowPoint(w) === at && w !== e8.selectedWindow()) e8.setWindowPoint(w, to);
  }
}

/**
 * Puts a process's output into its buffer at its mark, as comint-output-filter:
 * through comint-preoutput-filter-functions, marked as output, with carriage
 * motion done, then comint-output-filter-functions run, and the last line
 * left as the prompt.
 */
export function outputFilter(process: string, text: string): void {
  const buffer = e8.processBuffer(process);
  if (buffer === undefined || !e8.bufferLiveP(e8.getBuffer(buffer))) return;
  e8.withCurrentBuffer(buffer, () => {
    let string: string | undefined = text;
    for (const f of (e8.variable("comint-preoutput-filter-functions") ?? []) as e8.Value[]) {
      if (string === undefined) break;
      const result = e8.funcall(f as string, string);
      string = typeof result === "string" ? result : undefined;
    }
    if (string === undefined || string === "") return;
    const s = state();
    e8.letBind({ "inhibit-read-only": true }, () =>
      e8.saveRestriction(() => {
        e8.widen();
        const mark = processMark(process);
        const pointAtMark = e8.point() === mark;
        const saved = e8.makeMarker(e8.point(), { advances: true });
        e8.setMarker(s.lastOutputStart, mark);
        e8.gotoChar(mark);
        e8.insert(string!);
        e8.setMarker(e8.processMark(process)!, e8.point());
        carriageMotion(e8.markerPosition(s.lastOutputStart)!, e8.point());
        e8.setMarker(e8.processMark(process)!, e8.point());
        // ANSI colours, as ansi-color-process-output does first among comint-output-filter-functions.
        const ansi = e8.variable("ansi-color-for-comint-mode");
        if (ansi === true || ansi === "filter") {
          applyOnRegion(e8.markerPosition(s.lastOutputStart)!, processMark(process), ansi === "filter");
          e8.gotoChar(processMark(process));
        }
        const end = e8.point();
        e8.gotoChar(pointAtMark ? end : e8.markerPosition(saved)!);
        e8.runHooks("comint-output-filter-functions", string!);
        markAsOutput(e8.markerPosition(s.lastOutputStart)!, processMark(process));
        // The prompt: the output on the last line, with no newline after it.
        const promptStart = e8.lineBeginningPosition(processMark(process));
        e8.withSilentModifications(() => {
          if (!nil(e8.variable("comint-prompt-read-only")) && promptStart < processMark(process)) {
            e8.putTextProperty(promptStart, processMark(process), "read-only", true);
            e8.putTextProperty(promptStart, processMark(process), "front-sticky", ["read-only"]);
          }
          if (promptStart < processMark(process)) e8.addFaceTextProperty(promptStart, processMark(process), "comint-highlight-prompt");
        });
        advanceWindowPoints(buffer, mark, processMark(process));
        e8.deleteMarker(saved);
      }),
    );
  });
}

/** Adds an input to the history unless it is only spaces, or the same as the last with comint-input-ignoredups. */
function addToHistory(input: string): void {
  if (/^\s*$/.test(input)) return;
  const s = state();
  if (!nil(e8.variable("comint-input-ignoredups")) && s.ring[0] === input) return;
  s.ring.unshift(input);
  const size = Number(e8.variable("comint-input-ring-size") ?? 500);
  if (s.ring.length > size) s.ring.length = size;
}

/** The input at point when it is before the process mark, as comint-get-old-input-default. */
function oldInput(): string {
  const bof = e8.fieldBeginning();
  if (nil(e8.charProperty(bof, "field"))) return e8.fieldStringNoProperties(bof);
  const field = e8.charProperty(bof, "field");
  e8.call("comint-bol");
  return e8.bufferSubstringNoProperties(e8.point(), field === Symbol.for("output") ? e8.lineEndPosition() : e8.fieldEnd());
}

/** Sends the input after the process mark, or the old input at point, to the process, as comint-send-input. */
export function sendInput(noNewline = false, artificial = false): void {
  const proc = bufferProcess();
  e8.widen();
  const pmark = processMark(proc);
  let input: string;
  if (e8.point() >= pmark) {
    if (!nil(e8.variable("comint-eol-on-send"))) e8.gotoChar(e8.fieldEnd());
    input = e8.bufferSubstringNoProperties(pmark, e8.point());
  } else {
    input = oldInput();
    e8.gotoChar(pmark);
    e8.insert(input);
  }
  e8.letBind({ "inhibit-read-only": true }, () => {
    e8.deleteRegion(pmark, e8.point());
    e8.insert(input);
  });
  if (!noNewline) e8.insert("\n");
  addToHistory(input);
  const s = state();
  s.index = undefined;
  s.stored = undefined;
  const text = noNewline ? input : `${input}\n`;
  e8.runHooks("comint-input-filter-functions", text);
  const end = noNewline ? e8.point() : e8.point() - 1;
  e8.withSilentModifications(() => {
    if (end > pmark) e8.addFaceTextProperty(pmark, end, "comint-highlight-input");
    if (!noNewline) {
      // The newline separates the input from the output after it.
      e8.putTextProperty(end, end + 1, "rear-nonsticky", PROMPT_REAR_NONSTICKY);
      e8.putTextProperty(end, end + 1, "field", Symbol.for("boundary"));
    }
  });
  e8.setMarker(s.lastInputStart, pmark);
  e8.setMarker(s.lastInputEnd, e8.point());
  e8.setMarker(e8.processMark(proc)!, e8.point());
  e8.processSendString(proc, text);
  if (!artificial && !nil(e8.variable("comint-process-echoes"))) e8.setVariable("comint--echo-pending", text);
}

e8.defineVariable({ name: "comint--echo-pending", doc: "Input the program will echo, to take out of its output.", value: null, local: true });

/** Takes the echo of the input sent out of the output, as comint-process-echoes asks. */
const dropEcho = e8.defun("comint--drop-echo", (text: string) => {
  const pending = e8.variable("comint--echo-pending");
  if (typeof pending !== "string") return text;
  e8.setVariable("comint--echo-pending", null);
  return text.startsWith(pending) ? text.slice(pending.length) : text.replace(pending.replace(/\n$/, "\r\n"), "");
});

/** Starts a program in a buffer, on a terminal, with its output going through comint, as comint-exec. */
export function comintExec(buffer: string, name: string, command: string[], startfile?: string): string {
  const old = e8.getBufferProcess(buffer);
  if (old !== undefined) e8.deleteProcess(old);
  const directory = e8.withCurrentBuffer(buffer, () => e8.expandFileName("."));
  const width = e8.windowList().find((w) => e8.windowBuffer(w) === buffer);
  const size = width === undefined ? undefined : e8.windowSize(width);
  const proc = e8.makeProcess({
    name,
    buffer,
    command,
    directory,
    connectionType: "pty",
    env: {
      TERM: String(e8.variable("comint-terminfo-terminal") ?? "dumb"),
      INSIDE_EMACS: "e8,comint",
      ...(size ? { COLUMNS: String(size.width) } : {}),
    },
    filter: (p, text) => outputFilter(p, text),
  });
  if (size) e8.setProcessWindowSize(proc, size.height, size.width);
  e8.withCurrentBuffer(buffer, () => {
    e8.gotoChar(e8.pointMax());
    e8.setMarker(e8.processMark(proc)!, e8.pointMax());
    if (startfile !== undefined) e8.processSendString(proc, e8.readTextFile(startfile) ?? "");
  });
  return proc;
}

/**
 * Makes `buffer` a comint buffer running `program`, unless one already
 * runs there, as make-comint-in-buffer, and returns the buffer.
 */
export function makeComintInBuffer(name: string, buffer: string | undefined, program: string, startfile?: string, ...args: string[]): string {
  const b = buffer ?? `*${name}*`;
  e8.getBufferCreate(b);
  const running = e8.getBufferProcess(b);
  if (running === undefined || !e8.processLiveP(running)) {
    e8.withCurrentBuffer(b, () => {
      if (e8.variable("major-mode") !== "comint-mode" && !derivedFromComint()) e8.call("comint-mode");
    });
    comintExec(b, name, [program, ...args], startfile);
  }
  return b;
}

/** Whether the current buffer's mode derives from comint-mode. */
function derivedFromComint(): boolean {
  return e8.derivedModeP("comint-mode");
}

e8.defineMajorMode({
  name: "comint-mode",
  modeName: "Comint",
  doc:
    "The major mode for interacting with a program on a terminal: what you type after its prompt goes to it with RET.\n\n" +
    "M-p and M-n go through the inputs sent before, C-c C-c interrupts the job running, C-c C-d sends end of file, " +
    "and C-c C-o deletes the last output.",
  bindings: {
    RET: "comint-send-input",
    "C-d": "comint-delchar-or-maybe-eof",
    "M-p": "comint-previous-input",
    "M-n": "comint-next-input",
    "M-r": "comint-history-isearch-backward-regexp",
    "C-c M-r": "comint-previous-matching-input-from-input",
    "C-c M-s": "comint-next-matching-input-from-input",
    "C-<up>": "comint-previous-input",
    "C-<down>": "comint-next-input",
    "C-c C-a": "comint-bol-or-process-mark",
    "C-c C-u": "comint-kill-input",
    "C-c C-w": "backward-kill-word",
    "C-c C-c": "comint-interrupt-subjob",
    "C-c C-z": "comint-stop-subjob",
    "C-c C-\\": "comint-quit-subjob",
    "C-c C-m": "comint-copy-old-input",
    "C-c C-o": "comint-delete-output",
    "C-c M-o": "comint-clear-buffer",
    "C-c C-r": "comint-show-output",
    "C-c C-e": "comint-show-maximum-output",
    "C-c C-n": "comint-next-prompt",
    "C-c C-p": "comint-previous-prompt",
    "C-c C-d": "comint-send-eof",
  } as Record<string, e8.CommandName>,
  setup: () => {
    state();
    e8.addHook("isearch-mode-hook", historyIsearchSetup, { local: true });
    e8.setVariable("comint-preoutput-filter-functions", [dropEcho]);
    e8.setVariable("scroll-conservatively", 101);
  },
});

e8.defineFace({ name: "comint-highlight-prompt", doc: "The prompt in a comint buffer.", attributes: { inherit: "minibuffer-prompt" } });
e8.defineFace({ name: "comint-highlight-input", doc: "Input sent in a comint buffer.", attributes: { bold: true } });

e8.defineCommand({
  name: "comint-send-input",
  doc: "Send the input after the prompt to the program, with a newline; before the prompt, send the old input at point again.",
  run: () => sendInput(),
});

e8.defineCommand({
  name: "comint-send-eof",
  doc: "Send what is typed, without a newline, then end of file, as C-d does at a terminal.",
  run: () => {
    sendInput(true, true);
    e8.processSendEof(bufferProcess());
  },
});

e8.defineCommand({
  name: "comint-delchar-or-maybe-eof",
  doc: "Delete the next character, or send end of file at the end of the buffer with nothing typed.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const proc = e8.getBufferProcess(e8.bufferName());
    if (e8.point() === e8.pointMax() && proc !== undefined && e8.point() === processMark(proc)) e8.call("comint-send-eof");
    else e8.call("delete-char", arg);
  },
});

/** Replaces what is typed after the process mark with `text`. */
function replaceInput(text: string): void {
  const pmark = processMark(bufferProcess());
  e8.letBind({ "inhibit-read-only": true }, () => {
    e8.deleteRegion(pmark, e8.pointMax());
    e8.gotoChar(pmark);
    e8.insert(text);
  });
}

/** Whether point is at the command line, after the process mark. */
const afterPmark = (): boolean => processMark(bufferProcess()) <= e8.point();

/** The count to search with, as comint-search-arg: 0 starts again from the newest. */
function searchArg(arg: number): number {
  const s = state();
  if (!afterPmark()) e8.userError("Not at command line");
  if (s.ring.length === 0) e8.userError("Empty input ring");
  if (arg === 0) {
    s.index = undefined;
    return 1;
  }
  return arg;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * The index of the input matching `regexp` `arg` places along the history
 * from where M-p and M-n are, as comint-previous-matching-input-string-position:
 * back for a positive `arg`, forward for a negative one, round the ring.
 */
function matchingPosition(regexp: string, argIn: number): number | undefined {
  const s = state();
  const ring = s.ring;
  if (ring.length === 0) e8.userError("No history");
  const len = ring.length;
  let arg = argIn;
  const motion = arg > 0 ? 1 : -1;
  const start = s.index !== undefined ? mod(s.index + motion, len) : arg >= 0 ? 0 : len - 1;
  let n = mod(start - motion, len);
  let tried = false;
  const matches = (i: number) => e8.stringMatch(regexp, ring[i]!) !== undefined;
  while (arg !== 0 && !tried) {
    const prev = n;
    n = mod(n + motion, len);
    while (n < len && !tried && !matches(n)) {
      n = mod(n + motion, len);
      tried = n === prev;
    }
    arg += arg > 0 ? -1 : 1;
  }
  return matches(n) ? n : undefined;
}

/** Puts back what was typed before going through the history, as comint-restore-input. */
function restoreInput(): void {
  const s = state();
  if (s.index === undefined) return;
  replaceInput("");
  if ((s.stored ?? "") !== "") {
    replaceInput(s.stored!);
    e8.message("Input restored");
  }
  s.index = undefined;
}

/**
 * Puts the input matching `regexp` `n` places back in the history after
 * the prompt, forward if negative, as comint-previous-matching-input; with
 * `restore`, wrapping round puts back what was typed instead.
 */
function previousMatchingInput(regexp: string, nIn: number, restore = false): void {
  const n = searchArg(nIn);
  const s = state();
  const pos = matchingPosition(regexp, n);
  if (pos === undefined) e8.userError("Not found");
  if (s.index !== undefined && restore && ((n < 0 && s.index < pos) || (n > 0 && s.index > pos))) {
    restoreInput();
    return;
  }
  if (s.index === undefined) s.stored = e8.bufferSubstringNoProperties(processMark(bufferProcess()), e8.pointMax());
  s.index = pos;
  e8.message(`History item: ${pos + 1}`);
  replaceInput(s.ring[pos]!);
}

/** Goes `arg` inputs back in the history, forward if negative, as comint-previous-input. */
function previousInput(arg: number): void {
  const s = state();
  if (
    s.index !== undefined &&
    ((arg < 0 && s.index === 0) || (arg > 0 && s.index === s.ring.length - 1)) &&
    s.stored !== undefined
  ) {
    restoreInput();
  } else {
    previousMatchingInput(".", arg);
  }
}

/** Reads a regexp to search the history for, as comint-regexp-arg: empty means the last one. */
async function regexpArg(prompt: string): Promise<string> {
  const regexp = await e8.readString(prompt, { history: "minibuffer-history-search-history" });
  if (regexp !== "") return regexp;
  const history = e8.variable("minibuffer-history-search-history");
  return Array.isArray(history) && typeof history[0] === "string" ? history[0] : regexp;
}

e8.defineCommand({
  name: "comint-previous-matching-input",
  doc: "Put the last input matching a regexp after the prompt; with a prefix argument, the Nth last, or the Nth next if negative.",
  params: [{ name: "n", kind: "count" }],
  run: async (n: number) => previousMatchingInput(await regexpArg("Previous input matching (regexp): "), n),
});

e8.defineCommand({
  name: "comint-next-matching-input",
  doc: "Put the next input matching a regexp after the prompt; with a prefix argument, the Nth next, or the Nth last if negative.",
  params: [{ name: "n", kind: "count" }],
  run: async (n: number) => previousMatchingInput(await regexpArg("Next input matching (regexp): "), -n),
});

/** Goes `n` inputs back through those starting with what is typed before point, as comint-previous-matching-input-from-input. */
function matchingInputFromInput(n: number): void {
  const s = state();
  const opoint = e8.point();
  const last = e8.lastCommand();
  if (last !== "comint-previous-matching-input-from-input" && last !== "comint-next-matching-input-from-input") {
    s.matching = e8.bufferSubstringNoProperties(processMark(bufferProcess()), e8.point());
    s.index = undefined;
  }
  previousMatchingInput(`^${regexpQuote(s.matching)}`, n, true);
  if (e8.variable("comint-move-point-for-matching-input") === "after-input") e8.gotoChar(opoint);
}

e8.defineCommand({
  name: "comint-previous-matching-input-from-input",
  doc: "Put the last input that starts with what is typed before point after the prompt; again, the one before.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => matchingInputFromInput(n),
});

e8.defineCommand({
  name: "comint-next-matching-input-from-input",
  doc: "Put the next input that starts with what is typed before point after the prompt; again, the one after.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => matchingInputFromInput(-n),
});

/** Runs `f` in a buffer of its own, killed afterwards, as with-temp-buffer. */
function withTempBuffer<T>(f: () => T): T {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, f);
  } finally {
    e8.call("kill-buffer", name);
  }
}

/**
 * Reads the buffer's history from comint-input-ring-file-name, newest last
 * in the file, as comint-read-input-ring: entries are split by
 * comint-input-ring-separator, and those matching comint-input-history-ignore
 * are left out. With `silent`, says nothing if the file cannot be read.
 */
export function readInputRing(silent = false): void {
  const file = e8.variable("comint-input-ring-file-name");
  if (typeof file !== "string" || file === "") return;
  if (!e8.fileReadableP(e8.expandFileName(file))) {
    if (!silent) e8.message(`Cannot read history file ${file}`);
    return;
  }
  const size = Number(e8.variable("comint-input-ring-size") ?? 500);
  const separator = String(e8.variable("comint-input-ring-separator") ?? "\n");
  const prefix = e8.variable("comint-input-ring-file-prefix");
  const ignore = String(e8.variable("comint-input-history-ignore") ?? "^#");
  const ignoredups = !nil(e8.variable("comint-input-ignoredups"));
  const ring: string[] = [];
  withTempBuffer(() => {
    e8.insertFileContents(e8.expandFileName(file));
    e8.gotoChar(e8.pointMax());
    while (ring.length < size && e8.reSearchBackward(separator, { noerror: true }) !== undefined) {
      const end = e8.matchBeginning(0)!;
      e8.gotoChar(e8.reSearchBackward(separator, { noerror: true }) !== undefined ? e8.matchEnd(0)! : e8.pointMin());
      if (typeof prefix === "string" && prefix !== "" && e8.lookingAt(prefix)) e8.gotoChar(e8.matchEnd(0)!);
      const history = e8.bufferSubstringNoProperties(e8.point(), end);
      if (e8.stringMatch(ignore, history) === undefined && (!ignoredups || ring.length === 0 || ring[0] !== history)) ring.push(history);
    }
  });
  const s = state();
  s.ring = ring;
  s.index = undefined;
}
e8.defun("comint-read-input-ring", (silent?: boolean) => readInputRing(Boolean(silent)));

/** Writes the buffer's history to comint-input-ring-file-name, oldest first, as comint-write-input-ring. */
export function writeInputRing(): void {
  const file = e8.variable("comint-input-ring-file-name");
  const s = state();
  if (typeof file !== "string" || file === "" || s.ring.length === 0) return;
  const path = e8.expandFileName(file);
  if (!e8.fileWritableP(path)) {
    e8.message(`Cannot write history file ${file}`);
    return;
  }
  const separator = String(e8.variable("comint-input-ring-separator") ?? "\n");
  e8.writeTextFile(path, [...s.ring].reverse().map((input) => input + separator).join(""));
}
e8.defun("comint-write-input-ring", () => writeInputRing());

// Isearch in the input history, as comint.el's: M-r searches back through
// the inputs sent before for a regexp, each match put after the prompt in
// turn, the prompt showing the search's own.

e8.defineVariable({
  name: "comint-history-isearch",
  doc: "Whether C-r and C-M-r search the input history rather than the buffer: t always, dwim when the search starts at the command line, nil never. M-r searches the history whatever it says.",
  value: false,
});

/** Where the input on point's line starts, after the prompt, as comint-line-beginning-position. */
const lineBeginningPosition = (): number => e8.constrainToField(e8.lineBeginningPosition(), e8.lineEndPosition());

/** The start of the line the prompt is on. */
const promptLineStart = (): number => e8.lineBeginningPosition(lineBeginningPosition());

/** The overlay that shows the search's prompt over the program's, as comint-history-isearch-message-overlay. */
const messageOverlays = new Map<string, number>();

/** Puts the input `pos` places back in the history after the prompt, or what was typed for undefined, as comint-goto-input. */
function gotoInput(pos: number | undefined): void {
  const s = state();
  if (s.index === undefined) s.stored = oldInput();
  s.index = pos;
  if (pos !== undefined && s.ring.length > 0) replaceInput(s.ring[pos]!);
  else replaceInput(s.stored ?? "");
}

/** The function isearch searches the history with, as comint-history-isearch-search gives. */
function historyIsearchSearch(): (string: string, bound?: e8.Value, noerror?: e8.Value) => number | undefined {
  return (string, bound, noerror) => {
    const searchFun = isearchSearchFunDefault();
    const forward = e8.variable("isearch-forward") === true;
    const s = state();
    // Lazy highlighting searches with a bound: not in the prompt or the output.
    if (typeof bound === "number" && forward && !afterPmark()) e8.gotoChar(processMark(bufferProcess()));
    const here = searchFun(string, forward ? bound : lineBeginningPosition(), noerror);
    if (here !== undefined) return here;
    if (typeof bound === "number") return undefined;
    // Then put the inputs before or after this one in, one by one, and search each.
    return e8.conditionCase(
      () => {
        for (;;) {
          if (forward) {
            if (s.index === undefined) e8.signal("error", "End of history; no next item");
            previousInput(-1);
            e8.gotoChar(lineBeginningPosition());
          } else {
            if (s.index === s.ring.length - 1) e8.signal("error", "Beginning of history; no preceding item");
            previousInput(1);
            e8.gotoChar(e8.pointMax());
          }
          e8.setVariable("isearch-barrier", e8.point());
          e8.setVariable("isearch-opoint", e8.point());
          const found = searchFun(string, forward ? undefined : lineBeginningPosition(), noerror);
          if (found !== undefined) return e8.point();
        }
      },
      { error: () => undefined },
    );
  };
}

/** Shows the search's prompt over the program's while the search succeeds, as comint-history-isearch-message. */
function historyIsearchMessage(cqHack?: e8.Value, ellipsis?: e8.Value): void {
  if (e8.variable("isearch-success") !== true || truthyValue(e8.variable("isearch-error"))) {
    isearchMessage(truthyValue(cqHack), truthyValue(ellipsis));
    return;
  }
  const buffer = e8.bufferName();
  const start = promptLineStart();
  const end = lineBeginningPosition();
  let o = messageOverlays.get(buffer);
  if (o !== undefined && e8.overlayBuffer(o) === buffer) e8.moveOverlay(o, start, end);
  else {
    o = e8.makeOverlay(start, end);
    e8.overlayPut(o, "evaporate", true);
    messageOverlays.set(buffer, o);
  }
  e8.overlayPut(o, "display", isearchMessagePrefix(truthyValue(ellipsis)));
  const index = state().index;
  if (index !== undefined && !truthyValue(ellipsis)) e8.message(`History item: ${index + 1}`);
  else e8.message("");
}

/** Wraps a failing search round to the newest input or the oldest, as comint-history-isearch-wrap. */
function historyIsearchWrap(): void {
  const forward = e8.variable("isearch-forward") === true;
  if (forward) gotoInput(state().ring.length - 1);
  else gotoInput(undefined);
  e8.gotoChar(forward ? lineBeginningPosition() : e8.pointMax());
}

/** Keeps where the search is in the history with each of its states, as comint-history-isearch-push-state. */
function historyIsearchPushState(): (cmd: e8.Value) => void {
  const index = state().index;
  return () => gotoInput(index);
}

const truthyValue = (v: e8.Value | undefined) => v !== undefined && v !== null && v !== false;

const searchVariables: [string, e8.Value][] = [
  ["isearch-search-fun-function", historyIsearchSearch as unknown as e8.Value],
  ["isearch-message-function", historyIsearchMessage as unknown as e8.Value],
  ["isearch-wrap-function", historyIsearchWrap as unknown as e8.Value],
  ["isearch-push-state-function", historyIsearchPushState as unknown as e8.Value],
];

/** Makes a search that starts here search the history, as comint-history-isearch-setup on isearch-mode-hook. */
function historyIsearchSetup(): void {
  const how = e8.variable("comint-history-isearch");
  const proc = e8.getBufferProcess(e8.bufferName());
  if (proc === undefined) return;
  // Not where the prompt is empty, as in a finished shell's buffer.
  if (promptLineStart() === lineBeginningPosition()) return;
  if (!(how === true || (how === "dwim" && afterPmark()))) return;
  e8.setVariable("isearch-message-prefix-add", "history ");
  for (const [name, value] of searchVariables) {
    e8.makeLocalVariable(name);
    e8.setVariable(name, value);
  }
  e8.makeLocalVariable("isearch-lazy-count");
  e8.setVariable("isearch-lazy-count", false);
  e8.addHook("isearch-mode-end-hook", historyIsearchEnd, { local: true });
}

/** What comint-history-isearch was before M-r set it, put back as the search ends, as custom-reevaluate-setting does. */
let savedHowToSearch: e8.Value | undefined;

/** Puts the search back as it was, as comint-history-isearch-end on isearch-mode-end-hook. */
function historyIsearchEnd(): void {
  const o = messageOverlays.get(e8.bufferName());
  if (o !== undefined) e8.deleteOverlay(o);
  messageOverlays.delete(e8.bufferName());
  e8.setVariable("isearch-message-prefix-add", null);
  for (const [name] of searchVariables) e8.killLocalVariable(name);
  e8.killLocalVariable("isearch-lazy-count");
  // So the search leaves no mark behind.
  e8.setVariable("isearch-opoint", e8.point());
  e8.removeHook("isearch-mode-end-hook", historyIsearchEnd, { local: true });
  if (e8.variable("isearch-suspended") !== true && savedHowToSearch !== undefined) {
    e8.setVariable("comint-history-isearch", savedHowToSearch);
    savedHowToSearch = undefined;
  }
}

e8.defineCommand({
  name: "comint-history-isearch-backward",
  doc: "Search back through the input history for a string, incrementally: each match is put after the prompt.",
  run: () => {
    savedHowToSearch ??= e8.variable("comint-history-isearch") ?? false;
    e8.setVariable("comint-history-isearch", true);
    e8.call("isearch-backward");
  },
});

e8.defineCommand({
  name: "comint-history-isearch-backward-regexp",
  doc: "Search back through the input history for a regular expression, incrementally: each match is put after the prompt.",
  run: () => {
    savedHowToSearch ??= e8.variable("comint-history-isearch") ?? false;
    e8.setVariable("comint-history-isearch", true);
    e8.call("isearch-backward-regexp");
  },
});

e8.defineCommand({
  name: "comint-previous-input",
  doc: "Put the input sent before this one after the prompt, or as many back as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => previousInput(arg),
});

e8.defineCommand({
  name: "comint-next-input",
  doc: "Put the input sent after this one after the prompt, or as many on as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => previousInput(-arg),
});

e8.defineCommand({
  name: "comint-bol",
  doc: "Go to the start of the line, after the prompt if there is one.",
  run: () => {
    e8.gotoChar(e8.lineBeginningPosition());
    e8.gotoChar(e8.constrainToField(e8.point(), e8.lineEndPosition()));
  },
});

e8.defineCommand({
  name: "comint-bol-or-process-mark",
  doc: "Go to the start of the input on this line; again, to the process mark.",
  run: () => {
    if (e8.lastCommand() === "comint-bol-or-process-mark") e8.gotoChar(processMark(bufferProcess()));
    else e8.call("comint-bol");
  },
});

e8.defineCommand({
  name: "comint-kill-input",
  doc: "Kill what is typed after the prompt, up to point.",
  run: () => {
    const pmark = processMark(bufferProcess());
    if (e8.point() > pmark) e8.killRegion(pmark, e8.point());
  },
});

e8.defineCommand({
  name: "comint-copy-old-input",
  doc: "Copy the input at point to after the prompt, to send again.",
  run: () => {
    const input = oldInput();
    e8.gotoChar(processMark(bufferProcess()));
    e8.insert(input);
  },
});

/** Throws away what is typed but not sent, as comint-skip-input before a signal. */
function skipInput(): void {
  const proc = bufferProcess();
  const pmark = processMark(proc);
  e8.gotoChar(e8.pointMax());
  if (e8.point() > pmark) {
    e8.insert("  ");
    e8.setMarker(e8.processMark(proc)!, e8.point());
  }
}

for (const [name, doc, signal] of [
  ["comint-interrupt-subjob", "Interrupt the job running in the program, as C-c does at a terminal.", "INT"],
  ["comint-stop-subjob", "Stop the job running in the program, as C-z does at a terminal.", "TSTP"],
  ["comint-quit-subjob", "Send a quit signal to the job running in the program, as C-\\ does at a terminal.", "QUIT"],
] as const) {
  e8.defineCommand({
    name,
    doc,
    run: () => {
      if (signal === "INT") skipInput();
      const proc = bufferProcess();
      const fn = { INT: e8.interruptProcess, TSTP: e8.stopProcess, QUIT: e8.quitProcess }[signal];
      fn(proc, e8.processTtyName(proc) !== undefined);
    },
  });
}

e8.defineCommand({
  name: "comint-delete-output",
  doc: "Delete the output of the last input, leaving the prompt; with a prefix argument, kill it.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill: e8.PrefixArg) => {
    const proc = bufferProcess();
    const s = state();
    e8.letBind({ "inhibit-read-only": true }, () =>
      e8.saveExcursion(() => {
        const pmark = e8.lineBeginningPosition(processMark(proc));
        const from = e8.markerPosition(s.lastInputEnd)!;
        if (kill !== null) e8.killNew(e8.bufferSubstringNoProperties(from, pmark));
        const prompt = e8.bufferSubstringNoProperties(pmark, processMark(proc));
        e8.deleteRegion(from, processMark(proc));
        e8.gotoChar(from);
        e8.setMarker(e8.processMark(proc)!, from);
        outputFilter(proc, `*** output flushed ***\n${prompt}`);
      }),
    );
  },
});

e8.defineCommand({
  name: "comint-clear-buffer",
  doc: "Delete everything before the last prompt.",
  run: () => {
    const proc = bufferProcess();
    e8.letBind({ "inhibit-read-only": true }, () => {
      const start = e8.lineBeginningPosition(processMark(proc));
      e8.deleteRegion(e8.pointMin(), start);
    });
  },
});

e8.defineCommand({
  name: "comint-show-output",
  doc: "Put the start of the last output at the top of the window, with point at the input before it.",
  run: () => {
    const s = state();
    e8.gotoChar(e8.markerPosition(s.lastInputStart)!);
    e8.callWithPrefix(0, "recenter");
    e8.gotoChar(e8.lineBeginningPosition(e8.markerPosition(s.lastInputStart)!));
  },
});

e8.defineCommand({
  name: "comint-show-maximum-output",
  doc: "Go to the end of the buffer, showing as much output as fits.",
  run: () => {
    e8.gotoChar(e8.pointMax());
    e8.callWithPrefix(-1, "recenter");
  },
});

/** Goes to the start of the nth next input field, back if negative, as comint-next-prompt. */
function nextPrompt(nIn: number): void {
  let n = nIn;
  let pos = e8.point();
  let inputPos: number | undefined;
  while (n !== 0) {
    const prev = pos;
    pos = n > 0 ? e8.nextSingleCharPropertyChange(pos, "field") : e8.previousSingleCharPropertyChange(pos, "field");
    if (pos === prev) {
      if (n > 0) inputPos = e8.pointMax();
      n = 0;
    } else if (nil(e8.charProperty(pos, "field"))) {
      n += n < 0 ? 1 : -1;
      inputPos = pos;
    }
  }
  if (inputPos !== undefined) e8.gotoChar(inputPos);
}

e8.defineCommand({
  name: "comint-next-prompt",
  doc: "Go to the input after the next prompt, or as many on as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => nextPrompt(n),
});

e8.defineCommand({
  name: "comint-previous-prompt",
  doc: "Go to the input after the previous prompt, or as many back as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => nextPrompt(-n),
});

// Keep the history-forgetting hook from treating killed buffers' state as live.
e8.addHook("kill-buffer-hook", () => {
  states.delete(e8.bufferName());
});

/**
 * Reads a line without showing it and sends it to the buffer's process, as
 * comint-send-invisible: for passwords, which then go in no history.
 */
export async function sendInvisible(prompt = "Non-echoed text: "): Promise<void> {
  const buffer = e8.bufferName();
  const proc = e8.getBufferProcess(buffer);
  if (proc === undefined) throw new Error(`Buffer ${buffer} has no process`);
  const prefix = e8.windowBuffer() === buffer ? "" : `(In buffer ${buffer}) `;
  const str = await readPasswd(prefix + prompt);
  if (e8.processLiveP(proc)) e8.processSendString(proc, `${str}\n`);
}

e8.defineCommand({
  name: "comint-send-invisible",
  doc: "Read a line without showing it, as a password, and send it to the buffer's process.",
  run: () => sendInvisible(),
});

/** How deep password prompts have nested, so a program that keeps asking cannot recurse without end. */
let promptDepth = 0;

/**
 * Reads a password when the program's output ends in a prompt for one, as
 * comint-watch-for-password-prompt, the last of comint-output-filter-functions.
 */
export const watchForPasswordPrompt = (string: string): void => {
  const regexp = e8.variable("comint-password-prompt-regexp");
  if (typeof regexp !== "string" || e8.stringMatch(regexp, string.replaceAll("\r", ""), { caseFold: true }) === undefined) return;
  if (promptDepth >= 10) {
    e8.message("Password prompt recursion too deep");
    return;
  }
  if (e8.getBufferProcess(e8.bufferName()) === undefined) return;
  const prompt = string.replace(/^[ \n\r\t\v\f\b\x07]+/, "").replace(/\n+$/, "");
  promptDepth++;
  sendInvisible(prompt).finally(() => promptDepth--);
};
e8.addHook("comint-output-filter-functions", watchForPasswordPrompt);
