// Ediff, after Emacs's ediff.el and the files it loads (ediff-init.el,
// ediff-diff.el, ediff-util.el, ediff-wind.el, ediff-merg.el and
// ediff-help.el): two or three buffers or files compared side by side, their
// differences from the diff program, or diff3, highlighted, the current one
// refined word by word, and a control panel, *Ediff Control Panel*, whose
// keys move between the differences, copy them from one buffer to another,
// restore what a copy replaced, save the buffers and quit. Merging puts
// the result in a buffer of its own, *ediff-merge*, made from A and B, and
// with an ancestor from where each variant departed from it.
//
// Not preloaded: ediff-hook.ts defines the entry commands, which load this
// package, as Emacs autoloads ediff. A package that calls ediff imports
// what it needs from here, as magit-ediff.el calls ediff-buffers-internal:
//
//   import { ediffBuffersInternal } from "ediff";
//
// Each session's state is buffer-local in its control buffer under ediff's
// names (ediff-buffer-A, ediff-current-difference, ediff-quit-hook and the
// rest), so a startup hook can set them there as setq-local does in Lisp.
// The windows are laid out as ediff-setup-windows-plain lays them out: the
// variants in the frame, the control panel in a window below them.
//
// Left out for now: ediff-directories and the other group jobs, the
// session registry and meta buffer, regions and windows (ediff-regions-*,
// ediff-windows-*), patches and revisions, the control frame, suspending,
// swapping variants, regexp focus and hiding, wide display, and the
// commands for those (docs/differences.md).

import { allMatches, PerBuffer } from "subr";
import { ediffCommands, ediffOtherBuffer } from "ediff-hook";

type BufType = "A" | "B" | "C" | "Ancestor";
const BUF_TYPES: BufType[] = ["A", "B", "C", "Ancestor"];

// Options, as ediff's defcustoms.

for (const [name, doc, value, local] of [
  ["ediff-diff-program", "The program Ediff runs to find where two buffers differ, in diff's normal output.", "diff", false],
  ["ediff-diff3-program", "The program Ediff runs to compare three buffers, or merge two with an ancestor; it must write what GNU diff3 writes.", "diff3", false],
  ["ediff-diff-options", "Options given to ediff-diff-program, a string such as \"-w\". Options that change its output's format, -c and -u, or ignore case, -i, are refused.", "", false],
  ["ediff-diff3-options", "Options given to ediff-diff3-program, as a string.", "", false],
  ["ediff-custom-diff-program", "The program whose output D shows and wd saves.", "diff", false],
  ["ediff-custom-diff-options", "Options given to ediff-custom-diff-program: a context diff by default.", "-c", false],
  ["ediff-window-setup-function", "How Ediff lays out its windows. E8 has the plain layout only: the buffers compared fill the frame, and the control panel takes a window below them.", "ediff-setup-windows-plain", false],
  ["ediff-split-window-function", "How the buffers compared share the frame: split-window-vertically stacks them, split-window-horizontally puts them side by side. | switches between the two.", "split-window-vertically", true],
  ["ediff-merge-split-window-function", "As ediff-split-window-function, for A and B when merging.", "split-window-horizontally", true],
  ["ediff-merge-window-share", "The fraction of the frame's height the merge buffer's window gets.", 0.45, true],
  ["ediff-keep-variants", "Whether quitting leaves the buffers compared alone; when nil, q offers to kill each one that is unmodified. Comparing buffers always keeps them.", true, true],
  ["ediff-highlight-all-diffs", "Whether differences other than the current one are shaded too, alternating between the even and odd faces.", true, false],
  ["ediff-use-faces", "Whether Ediff shows differences with faces.", true, false],
  ["ediff-auto-refine", "When the words that differ within the current region are found and shown: on, as each region is selected; off, only those found before are shown; nix, none shown until * asks. @ goes through them.", e8.intern("on"), true],
  ["ediff-auto-refine-limit", "Regions longer than this many characters are not split into words without *.", 14000, true],
  ["ediff-ignore-similar-regions", "Whether n and p pass over regions whose words are all the same, differing only in spaces and line breaks. ## turns it on and off.", false, true],
  ["ediff-make-buffers-readonly-at-startup", "Whether Ediff makes the buffers it compares read-only when it starts.", false, false],
  ["ediff-use-long-help-message", "Whether the control panel shows every key, rather than a line saying ? does. ? turns it on and off.", false, true],
  ["ediff-default-variant", "What a merge puts in the merge buffer where A and B both changed: default-A or default-B for that variant's text, combined for both between markers.", e8.intern("combined"), false],
  ["ediff-combination-pattern", "How + and a combined merge write a region: a list alternating marker lines and the symbols A, B or Ancestor for whose text follows the marker, ending in a last marker. A region that is not there, as the ancestor's without one, is left out with its marker.", ["<<<<<<< variant A", e8.intern("A"), ">>>>>>> variant B", e8.intern("B"), "####### Ancestor", e8.intern("Ancestor"), "======= end"], true],
  ["ediff-show-clashes-only", "Whether n and p pass over merge regions only one variant changed from the ancestor. $$ turns it on and off.", false, true],
  ["ediff-skip-merge-regions-that-differ-from-default", "Whether n and p pass over merge regions already edited away from what the merge put in. $* turns it on and off.", false, true],
  ["ediff-autostore-merges", "Whether quitting a merge saves its result: t asks for a file unless one was given, nil never saves, and anything else saves only merges started for a group of files, which E8 does not have yet.", e8.intern("group-jobs-only"), true],
  ["ediff-merge-store-file", "The file a merge's result goes to, when the merge was given one.", null, true],
  ["ediff-show-ancestor", "Whether a merge with an ancestor shows the ancestor beside the merge buffer.", true, false],
  ["ediff-verbose-p", "Whether Ediff says in the echo area what it is doing, such as refining a region.", true, false],
  ["ediff-whitespace", "The characters, as skip-chars-forward takes them, that separate words when a region is split into words, and that are not compared.", " \n\t\f\r ", true],
  ["ediff-word-1", "Characters that make up the first kind of word a region is split into, with those of word syntax.", "-[:word:]_", true],
  ["ediff-word-2", "Characters that make up the second kind of word: numbers.", "0-9.,", true],
  ["ediff-word-3", "Characters that make up the third kind of word: punctuation and brackets.", "`'?!:;\"{}[]()", true],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value, local });
}
e8.defineVariable({
  name: "ediff-word-4",
  doc: "Characters that make up the fourth kind of word: those of none of the other kinds, nor white space.",
  value: "^" + ["ediff-word-1", "ediff-word-2", "ediff-word-3", "ediff-whitespace"].map((v) => String(e8.defaultValue(v))).join(""),
  local: true,
});

// A session's state, buffer-local in its control buffer, as ediff's
// ediff-defvar-local variables are.
for (const [name, doc] of [
  ["ediff-buffer-A", "In a control panel, the first buffer compared."],
  ["ediff-buffer-B", "In a control panel, the second buffer compared."],
  ["ediff-buffer-C", "In a control panel, the third buffer compared, or the buffer a merge writes its result in."],
  ["ediff-ancestor-buffer", "In a control panel of a merge, the version A and B both started from, if it was given."],
  ["ediff-control-buffer", "The control panel a session's buffers belong to."],
  ["ediff-control-window", "The window showing the control panel."],
  ["ediff-window-A", "The window Ediff shows buffer A in."],
  ["ediff-window-B", "The window Ediff shows buffer B in."],
  ["ediff-window-C", "The window Ediff shows buffer C in."],
  ["ediff-window-Ancestor", "The window Ediff shows the ancestor in, when it is shown."],
  ["ediff-control-frame", "Frame used for the control panel; nil in E8, which keeps it in a window."],
  ["ediff-job-name", "The kind of job running: ediff-buffers, ediff-files3, ediff-merge-buffers-with-ancestor and so on."],
  ["ediff-3way-comparison-job", "Whether this is a comparison of three buffers."],
  ["ediff-merge-job", "Whether this is a merge."],
  ["ediff-merge-with-ancestor-job", "Whether this is a merge with an ancestor."],
  ["ediff-3way-job", "Whether this job has a buffer C: a three-way comparison or a merge."],
  ["ediff-diff3-job", "Whether this job runs diff3."],
  ["ediff-current-difference", "The difference region selected, counting from 0; -1 before the first."],
  ["ediff-number-of-differences", "How many difference regions there are."],
  ["ediff-diff-buffer", "The buffer holding the output of the diff the regions came from."],
  ["ediff-fine-diff-buffer", "The buffer holding the output of the diff that split the current region into words."],
  ["ediff-custom-diff-buffer", "The buffer holding ediff-custom-diff-program's output, which D shows and wd saves."],
  ["ediff-error-buffer", "The buffer holding what diff wrote that was not differences."],
  ["ediff-diff-status", "The current difference's status in a variant's mode line: [=diff(B)] where it is the same as B's."],
] as const) {
  e8.defineVariable({ name, doc, value: name === "ediff-current-difference" ? -1 : null, local: true });
}
e8.defineVariable({ name: "ediff-tmp-buffer", doc: "The buffer regions are split into words in.", value: " *ediff-tmp*" });
e8.defineVariable({ name: "ediff-msg-buffer", doc: "The buffer for messages too long for the echo area.", value: " *ediff-message*" });
e8.defineVariable({ name: "ediff-debug-buffer", doc: "The buffer for Ediff's debugging output, killed on quitting.", value: "*ediff-debug*", local: true });

// Hooks, as ediff-init.el's.
for (const [name, doc] of [
  ["ediff-before-setup-hook", "Run as a session starts, before it makes any buffer or window."],
  ["ediff-before-setup-windows-hook", "Run before Ediff lays out its windows."],
  ["ediff-after-setup-windows-hook", "Run after Ediff lays out its windows."],
  ["ediff-startup-hook", "Run in the control panel once a session is ready, after the startup hooks it was given."],
  ["ediff-select-hook", "Run in the control panel each time a region becomes the current one."],
  ["ediff-unselect-hook", "Run in the control panel each time a region stops being the current one."],
  ["ediff-prepare-buffer-hook", "Run in each buffer compared as a session starts."],
  ["ediff-mode-hook", "Run when a control panel is put in ediff-mode."],
  ["ediff-keymap-setup-hook", "Run in a new control panel once its keys are bound, to change them."],
  ["ediff-display-help-hook", "Run each time the control panel's help is written."],
  ["ediff-quit-hook", "Run in the control panel last when quitting; it holds ediff-cleanup-mess, which kills the panel and Ediff's other buffers. A package that sets its own value in the panel does its own cleaning up."],
  ["ediff-cleanup-hook", "Run in the control panel when quitting, before any buffer is killed."],
  ["ediff-quit-merge-hook", "Run in the control panel when quitting a merge, before the other quitting hooks; ediff-maybe-save-and-delete-merge by default."],
  ["ediff-after-quit-hook-internal", "Functions run last of all when quitting, the control panel's own value, after the panel is gone."],
] as const) {
  e8.defineHook(name, doc);
}

// Faces, as ediff-init.el's for 88 colours or more.
const FACE_DOCS: Record<string, string> = {
  current: "The current region in buffer",
  fine: "The words that differ within the current region in buffer",
  even: "The even-numbered regions other than the current one, as the user counts them, in buffer",
  odd: "The odd-numbered regions other than the current one in buffer",
};
for (const [kind, type, light, dark] of [
  ["current", "A", { background: "#ffdddd" }, { background: "#553333" }],
  ["current", "B", { background: "#ddffdd" }, { background: "#335533" }],
  ["current", "C", { background: "#ffffaa" }, { background: "#888833" }],
  ["current", "Ancestor", { background: "#cfdeee" }, { background: "#004151" }],
  ["fine", "A", { background: "#ffbbbb" }, { background: "#aa2222" }],
  ["fine", "B", { background: "#aaffaa" }, { background: "#22aa22" }],
  ["fine", "C", { background: "#ffff55" }, { background: "#aaaa22" }],
  ["fine", "Ancestor", { background: "#00c5c0" }, { background: "#009591" }],
  ["even", "A", { distantForeground: "Black", background: "light grey" }, { distantForeground: "White", background: "dark grey" }],
  ["even", "B", { distantForeground: "Black", background: "Grey" }, { distantForeground: "White", background: "dim grey" }],
  ["even", "C", { distantForeground: "Black", background: "light grey" }, { distantForeground: "White", background: "dark grey" }],
  ["even", "Ancestor", { distantForeground: "Black", background: "Grey" }, { distantForeground: "White", background: "dim grey" }],
  ["odd", "A", { distantForeground: "Black", background: "Grey" }, { distantForeground: "White", background: "dim grey" }],
  ["odd", "B", { distantForeground: "Black", background: "light grey" }, { distantForeground: "White", background: "dark grey" }],
  ["odd", "C", { distantForeground: "Black", background: "Grey" }, { distantForeground: "White", background: "dim grey" }],
  ["odd", "Ancestor", { background: "gray40" }, { background: "gray40" }],
] as const) {
  e8.defineFace({
    name: `ediff-${kind}-diff-${type}`,
    doc: `${FACE_DOCS[kind]} ${type}.`,
    attributes: { extend: kind !== "fine" } as e8.FaceAttributes,
    light: light as e8.FaceAttributes,
    dark: dark as e8.FaceAttributes,
  });
}

// Messages, as ediff-init.el's constants.
const KILLED_VITAL_BUFFER = "You have killed a vital Ediff buffer---you must leave Ediff now!";
const NO_DIFFERENCES = "Sorry, comparison of identical variants is not what I am made for...";

// Help messages, as ediff-help.el's.
const LONG_HELP_HEAD =
  "    Move around      |      Toggle features      |        Manipulate\n" +
  "=====================|===========================|=============================";
const LONG_HELP_TAIL =
  "=====================|===========================|=============================\n" +
  "    R -show registry |     = -compare regions    |  M   -show session group\n" +
  "    D -diff output   |     E -browse Ediff manual|  G   -send bug report\n" +
  "    i -status info   |     ? -help off           |  z/q -suspend/quit\n" +
  "-------------------------------------------------------------------------------\n" +
  "For help on a specific command:  Click Button 2 over it; or\n" +
  "              \t\t\t Put the cursor over it and type RET.";
const LONG_HELP_COMPARE3 = `
p,DEL -previous diff |     | -vert/horiz split   | xy -copy buf X's region to Y
n,SPC -next diff     |     h -highlighting       | rx -restore buf X's old diff
    j -jump to diff  |     @ -auto-refinement    |  * -refine current region
   gx -goto X's point|    ## -ignore whitespace  |  ! -update diff regions
  C-l -recenter      |    #c -ignore case        |
  v/V -scroll up/dn  | #f/#h -focus/hide regions | wx -save buf X
  </> -scroll lt/rt  |     X -read-only in buf X | wd -save diff output
    ~ -rotate buffers|     m -wide display       |
`;
const LONG_HELP_COMPARE2 = `
p,DEL -previous diff |     | -vert/horiz split   |a/b -copy A/B's region to B/A
n,SPC -next diff     |     h -highlighting       | rx -restore buf X's old diff
    j -jump to diff  |     @ -auto-refinement    |  * -refine current region
   gx -goto X's point|    ## -ignore whitespace  |  ! -update diff regions
  C-l -recenter      |    #c -ignore case        |
  v/V -scroll up/dn  | #f/#h -focus/hide regions | wx -save buf X
  </> -scroll lt/rt  |     X -read-only in buf X | wd -save diff output
    ~ -swap variants |     m -wide display       |
`;
const LONG_HELP_MERGE = `
p,DEL -previous diff |     | -vert/horiz split   |  x -copy buf X's region to C
n,SPC -next diff     |     h -highlighting       |  r -restore buf C's old diff
    j -jump to diff  |     @ -auto-refinement    |  * -refine current region
   gx -goto X's point|    ## -ignore whitespace  |  ! -update diff regions
  C-l -recenter      | #f/#h -focus/hide regions |  + -combine diff regions
  v/V -scroll up/dn  |     X -read-only in buf X | wx -save buf X
  </> -scroll lt/rt  |     m -wide display       | wd -save diff output
    ~ -swap variants |     s -shrink window C    |  / -show/hide ancestor buff
                     |  $$ -show clashes only    |  & -merge w/new default
                     |  $* -skip changed regions |
`;
const BRIEF_HELP = " Type ? for help";

// A session.

/** An overlay and its buffer, as the overlay functions act on the current buffer's. */
interface Ov {
  buffer: e8.Buffer;
  id: number;
}

const inOverlayBuffer = <T>(o: Ov, fn: () => T): T | undefined => (o.buffer.live ? e8.withCurrentBuffer(o.buffer, fn) : undefined);
const ovStart = (o: Ov) => inOverlayBuffer(o, () => e8.overlayStart(o.id));
const ovEnd = (o: Ov) => inOverlayBuffer(o, () => e8.overlayEnd(o.id));
const ovPut = (o: Ov, name: string, value: e8.Value) => void inOverlayBuffer(o, () => e8.overlayPut(o.id, name, value));
const ovMove = (o: Ov, start: number, end: number) => void inOverlayBuffer(o, () => e8.moveOverlay(o.id, start, end));
const ovDelete = (o: Ov) => void inOverlayBuffer(o, () => e8.deleteOverlay(o.id));

/** A difference region in one buffer: its overlay, the overlays of its fine differences, and its state in three-way jobs. */
interface DiffRecord {
  overlay: Ov;
  fine: Ov[] | null;
  /** In buffer A's record only: whether the region differs only in white space, or in which buffer it is white space only. */
  noFineDiffs: boolean | BufType | null;
  /** "=diff(B)" where this buffer's region is the same as B's. */
  state: string | null;
}

interface Session {
  control: e8.Buffer;
  job: string;
  buffers: Partial<Record<BufType, e8.Buffer>>;
  diffs: Record<BufType, DiffRecord[]>;
  /** For merges, each region's state of merge (default-A, prefer-B, combined...) and whether the ancestor's is empty. */
  merge: { state: string | null; ancestorEmpty: boolean }[] | null;
  current: number;
  count: number;
  /** The overlays that show the current difference, in each buffer. */
  currentOverlay: Partial<Record<BufType, Ov>>;
  /** Overlays over each buffer's compared text, as ediff-wide-bounds. */
  bounds: Partial<Record<BufType, Ov>>;
  /** What copying over each region replaced, by region and buffer, as ediff-killed-diffs-alist. */
  killed: Map<number, Map<BufType, string>>;
  /** Each variant's mode line before Ediff changed it: its own value, or undefined if it had none. */
  modeLines: Map<e8.Buffer, e8.Value | undefined>;
  windows: Partial<Record<BufType | "control", number>>;
  /** The window layout last set up, to tell whether it must be done again, as ediff-window-config-saved. */
  configSaved: string;
  syntaxTable: string;
  is3wayComparison: boolean;
  isMerge: boolean;
  isMergeWithAncestor: boolean;
  is3way: boolean;
  isDiff3: boolean;
  diffBuffer?: e8.Buffer;
  fineDiffBuffer?: e8.Buffer;
  errorBuffer?: e8.Buffer;
  customDiffBuffer?: e8.Buffer;
}

const sessions = new PerBuffer<Session>();

const live = (b: e8.Buffer | undefined): b is e8.Buffer => b !== undefined && b.live;
const windowLive = (w: number | undefined): w is number => w !== undefined && e8.windowList().includes(w);
const verbose = () => e8.variable("ediff-verbose-p") !== null && e8.variable("ediff-verbose-p") !== false;
const truthy = (v: e8.Value | undefined) => v !== undefined && v !== null && v !== false;
/** A value as ediff's %S formats it: a symbol by its name, a buffer as #<buffer NAME>. */
const symbolName = (v: e8.Value | undefined) => (typeof v === "symbol" ? e8.symbolName(v) : String(v));

/** Clear the echo area without logging, as (message "") does. */
const clearMessage = () => e8.message("", { log: false });

function messageIfVerbose(text: string): void {
  if (verbose()) e8.message(text);
}

/** Run fn in a session's buffer, failing as ediff-with-current-buffer does if it is gone. */
function withBuffer<T>(buffer: e8.Buffer | undefined, fn: () => T): T {
  if (!live(buffer)) e8.signal("error", KILLED_VITAL_BUFFER);
  return e8.withCurrentBuffer(buffer!, fn);
}

/** The session whose control buffer is current, or the user error ediff-barf-if-not-control-buffer gives. */
function session(): Session {
  const s = sessions.get(e8.bufferName());
  if (s === undefined) e8.userError(`${e8.thisCommand() ?? "ediff"}: This command runs in Ediff Control Buffer only!`);
  return s!;
}

/** A variable's value in the session's control buffer. */
const ctlVar = (s: Session, name: string) => e8.bufferLocalValue(name, s.control);

/** Copy the session's state to the variables in its control buffer that code outside reads. */
function publish(s: Session): void {
  e8.withCurrentBuffer(s.control, () => {
    e8.setVariable("ediff-current-difference", s.current);
    e8.setVariable("ediff-number-of-differences", s.count);
    for (const t of ["A", "B", "C", "Ancestor"] as const) {
      e8.setVariable(`ediff-window-${t}`, s.windows[t] ?? null);
    }
    e8.setVariable("ediff-control-window", s.windows.control ?? null);
  });
}

/** The first of prefix SUFFIX, prefix<2>SUFFIX and on that no buffer has, as ediff-unique-buffer-name. */
function uniqueBufferName(prefix: string, suffix: string): string {
  if (e8.getBuffer(prefix + suffix) === undefined) return prefix + suffix;
  let n = 2;
  while (e8.getBuffer(`${prefix}<${n}>${suffix}`) !== undefined) n++;
  return `${prefix}<${n}>${suffix}`;
}

function killBufferCarefully(buffer: e8.Buffer | string | undefined | null): void {
  const b = typeof buffer === "string" ? e8.getBuffer(buffer) : buffer ?? undefined;
  if (live(b)) e8.call("kill-buffer", b.name!);
}

/** A window showing a buffer, as get-buffer-window. */
function bufferWindow(buffer: e8.Buffer | undefined): number | undefined {
  if (!live(buffer)) return undefined;
  return e8.windowList().find((w) => e8.windowBuffer(w) === buffer.name);
}

/** Write a buffer's accessible text to a new temporary file, as ediff-make-temp-file. */
function makeTempFile(buffer: e8.Buffer, prefix?: string, start?: number, end?: number): string {
  const text = withBuffer(buffer, () => e8.bufferSubstringNoProperties(start ?? e8.pointMin(), end ?? e8.pointMax()));
  return e8.makeTempFile(prefix ?? "ediff", { text });
}

function deleteFileQuietly(file: string | undefined): void {
  if (file !== undefined && e8.fileExistsP(file)) e8.deleteFile(file);
}

/** The options in a string, as split-string splits them. */
const splitOptions = (options: e8.Value | undefined) => String(options ?? "").split(/\s+/).filter(Boolean);

/** Run a diff program into a buffer, as ediff-exec-process does synchronously. */
function execProcess(program: string, buffer: e8.Buffer, options: string, files: (string | undefined)[]): void {
  const args = [...splitOptions(options), ...files.filter((f): f is string => typeof f === "string" && f !== "")];
  const result = e8.callProcess([program, ...args], { directory: "/" });
  e8.withCurrentBuffer(buffer, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      e8.insert(result.output);
    });
  });
}

const DIFF_OK_LINES = /^([0-9,]+[acd][0-9,]+\r?$|[<>] |---|.*Warning *:|.*No +newline|.*missing +newline|\r?$)/;
const DIFF3_OK_LINES = /^([1-3]:|====|  |.*Warning *:|.*No newline|.*missing newline|\r$)/;

/** Fail with diff's errors in a buffer of their own, as ediff-prepare-error-list. */
function prepareErrorList(s: Session, ok: RegExp, diffBuffer: e8.Buffer): void {
  if (!live(s.errorBuffer)) s.errorBuffer = e8.getBufferCreate(uniqueBufferName("*ediff-errors", "*"));
  const output = e8.withCurrentBuffer(diffBuffer, () => e8.bufferText());
  const errors = output.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === "") && !ok.test(l));
  e8.withCurrentBuffer(s.errorBuffer, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    if (errors.length > 0) e8.insert(errors.join("\n") + "\n");
  });
  if (errors.length > 0) {
    e8.call("switch-to-buffer", s.errorBuffer.name!);
    killBufferCarefully(s.control);
    e8.userError(`Errors in diff output.  Diff output is in #<buffer ${diffBuffer.name}>`);
  }
}

/** A hunk of differences, as line or word numbers from 1, the end not included. */
interface Hunk {
  a: [number, number];
  b: [number, number];
  c?: [number, number];
  /** The agreement diff3 reports: which file differs from the other two, "" for all three. */
  agreement?: string;
}

const DIFF_LINE = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?\r?$/gm;

/** The hunks of diff's normal output, as ediff-extract-diffs reads them. */
function parseDiff(output: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const m of allMatches(DIFF_LINE, output)) {
    let aBegin = Number(m[1]);
    let aEnd = m[2] === undefined ? aBegin : Number(m[2]);
    let bBegin = Number(m[4]);
    let bEnd = m[5] === undefined ? bBegin : Number(m[5]);
    if (m[3] === "a") {
      bEnd += 1;
      aBegin += 1;
      aEnd = aBegin;
    } else if (m[3] === "d") {
      aEnd += 1;
      bBegin += 1;
      bEnd = bBegin;
    } else {
      aEnd += 1;
      bEnd += 1;
    }
    hunks.push({ a: [aBegin, aEnd], b: [bBegin, bEnd] });
  }
  return hunks;
}

/** The hunks of diff3's output, each file's lines by its number "1", "2" or "3", as ediff-get-diff3-group reads them. */
function parseDiff3(output: string): { agreement: string; groups: Record<string, [number, number]> }[] {
  const hunks: { agreement: string; groups: Record<string, [number, number]> }[] = [];
  for (const line of output.split("\n")) {
    const head = /^====(.?)\r?$/.exec(line);
    if (head) {
      hunks.push({ agreement: head[1], groups: {} });
      continue;
    }
    const group = /^([1-3]):(\d+)(?:,(\d+))?([ac])\r?$/.exec(line);
    if (group && hunks.length > 0) {
      const x = Number(group[2]);
      hunks[hunks.length - 1].groups[group[1]] =
        group[4] === "c" ? (group[3] !== undefined ? [x, Number(group[3]) + 1] : [x, x + 1]) : [x + 1, x + 1];
    }
  }
  return hunks;
}

/** Where line `line` (from 1) of text starting at `start` begins in the current buffer. */
function linePosition(start: number, line: number): number {
  const base = e8.lineOf(start);
  const target = base + line - 1;
  if (target > e8.lineOf(e8.pointMax())) return e8.pointMax();
  return Math.min(e8.pointMax(), Math.max(start, e8.lineStart(target)));
}

/** An overlay that stays over its text as text is put in at either end, as ediff-make-bullet-proof-overlay. */
function bulletProofOverlay(buffer: e8.Buffer, start: number, end: number): Ov {
  return { buffer, id: e8.withCurrentBuffer(buffer, () => e8.makeOverlay(start, end, { "ediff-diff-num": 0 }, { rearAdvance: true })) };
}

const regionsStart = (s: Session, t: BufType) => {
  const o = s.bounds[t];
  return o === undefined ? withBuffer(s.buffers[t], () => e8.pointMin()) : ovStart(o)!;
};

/** The background face of a region that is not current, as ediff-background-face: odd regions, as the user counts, get the even face. */
const backgroundFace = (t: BufType, n: number) => `ediff-${n % 2 === 1 ? "even" : "odd"}-diff-${t}`;
const highlightAll = () => truthy(e8.variable("ediff-highlight-all-diffs")) && truthy(e8.variable("ediff-use-faces"));

/**
 * Lay the regions in `points`, each buffer's [begin, end] positions, over
 * the buffers as overlays, as ediff-convert-diffs-to-overlays, with each
 * region's state in three-way jobs.
 */
function setDiffOverlays(s: Session, regions: { pos: Partial<Record<BufType, [number, number]>>; diffState: BufType | null }[]): void {
  for (const t of BUF_TYPES) {
    s.diffs[t] = [];
    const buffer = s.buffers[t];
    if (!live(buffer)) continue;
    if (t === "C" && !s.is3way) continue;
    if (t === "Ancestor" && !s.isMergeWithAncestor) continue;
    regions.forEach((r, n) => {
      const [begin, end] = r.pos[t]!;
      const overlay = bulletProofOverlay(buffer, begin, end);
      ovPut(overlay, "ediff-diff-num", n);
      if (highlightAll()) ovPut(overlay, "face", backgroundFace(t, n));
      let state: string | null = null;
      if (t !== r.diffState && t !== "Ancestor" && r.diffState !== null) {
        state = `=diff(${(["A", "B", "C"] as BufType[]).find((x) => x !== t && x !== r.diffState)})`;
      }
      if (n % 10 === 0) e8.message(`Buffer ${t}: Processing difference region ${n} of ${regions.length}`);
      s.diffs[t].push({ overlay, fine: null, noFineDiffs: null, state });
    });
  }
  e8.message("Processing difference regions ... done");
}

/** Positions in a buffer of lines from a diff of its text starting at `start`. */
function linesToPoints(buffer: e8.Buffer, start: number, [begin, end]: [number, number]): [number, number] {
  return e8.withCurrentBuffer(buffer, () => [linePosition(start, begin), linePosition(start, end)]);
}

/** Run diff on two files and lay its regions over A and B, and C in merges, as ediff-setup-diff-regions. */
function setupDiffRegions(s: Session, fileA: string, fileB: string): void {
  const options = String(e8.variable("ediff-diff-options") ?? "");
  if (/^-[ciu]| -[ciu]|(^| )-[^- ]+[ciu]/.test(options)) {
    e8.signal("error", "Options ‘-c’, ‘-u’, and ‘-i’ are not allowed in ‘ediff-diff-options’");
  }
  if (!live(s.diffBuffer)) s.diffBuffer = e8.getBufferCreate(uniqueBufferName("*ediff-diff", "*"));
  execProcess(String(e8.variable("ediff-diff-program") ?? "diff"), s.diffBuffer, options, [fileA, fileB]);
  clearMessage();
  prepareErrorList(s, DIFF_OK_LINES, s.diffBuffer);
  const output = e8.withCurrentBuffer(s.diffBuffer, () => e8.bufferText());
  const defaultB = symbolName(e8.variable("ediff-default-variant")) === "default-B";
  const startA = regionsStart(s, "A");
  const startB = regionsStart(s, "B");
  const startC = live(s.buffers.C) ? withBuffer(s.buffers.C, () => e8.pointMin()) : 0;
  const regions = parseDiff(output).map((h) => {
    const pos: Partial<Record<BufType, [number, number]>> = {
      A: linesToPoints(s.buffers.A!, startA, h.a),
      B: linesToPoints(s.buffers.B!, startB, h.b),
    };
    if (live(s.buffers.C)) pos.C = linesToPoints(s.buffers.C, startC, defaultB ? h.b : h.a);
    return { pos, diffState: live(s.buffers.C) ? ((defaultB ? "A" : "B") as BufType) : null };
  });
  setDiffOverlays(s, regions);
  if (s.isMerge) {
    const variant = symbolName(e8.variable("ediff-default-variant"));
    s.merge = regions.map(() => ({ state: variant, ancestorEmpty: false }));
  }
}

/** Run diff3 on three files and lay its regions over the buffers, as ediff-setup-diff-regions3. */
function setupDiffRegions3(s: Session, fileA: string, fileB: string, fileC: string): void {
  if (!live(s.diffBuffer)) s.diffBuffer = e8.getBufferCreate(uniqueBufferName("*ediff-diff", "*"));
  e8.message("Computing differences ...");
  // With an ancestor, it is the middle file.
  const files = s.isMergeWithAncestor ? [fileA, fileC, fileB] : [fileA, fileB, fileC];
  execProcess(String(e8.variable("ediff-diff3-program") ?? "diff3"), s.diffBuffer, String(e8.variable("ediff-diff3-options") ?? ""), files);
  prepareErrorList(s, DIFF3_OK_LINES, s.diffBuffer);
  const output = e8.withCurrentBuffer(s.diffBuffer, () => e8.bufferText());
  const threeWay = s.is3wayComparison;
  const [aIdx, bIdx, cIdx] = threeWay ? ["1", "2", "3"] : ["1", "3", "2"];
  const variant = symbolName(e8.variable("ediff-default-variant"));
  const starts = { A: regionsStart(s, "A"), B: regionsStart(s, "B"), C: threeWay ? regionsStart(s, "C") : withBuffer(s.buffers.C, () => e8.pointMin()) };
  const ancStart = live(s.buffers.Ancestor) ? withBuffer(s.buffers.Ancestor, () => e8.pointMin()) : 0;
  const regions: { pos: Partial<Record<BufType, [number, number]>>; diffState: BufType | null }[] = [];
  const merge: { state: string | null; ancestorEmpty: boolean }[] = [];
  for (const hunk of parseDiff3(output)) {
    // Merging, a region where A and B agree is no difference.
    if (!threeWay && hunk.agreement === cIdx) continue;
    const a = hunk.groups[aIdx];
    const b = hunk.groups[bIdx];
    const cOrAnc = hunk.groups[cIdx];
    if (!a || !b || !cOrAnc) continue;
    const stateOfMerge = hunk.agreement === aIdx ? "prefer-A" : hunk.agreement === bIdx ? "prefer-B" : variant;
    const c = threeWay ? cOrAnc : variant === "default-B" ? b : a;
    const pos: Partial<Record<BufType, [number, number]>> = {
      A: linesToPoints(s.buffers.A!, starts.A, a),
      B: linesToPoints(s.buffers.B!, starts.B, b),
      C: linesToPoints(s.buffers.C!, starts.C, c),
    };
    if (live(s.buffers.Ancestor)) pos.Ancestor = linesToPoints(s.buffers.Ancestor, ancStart, cOrAnc);
    const comparisonState = hunk.agreement === aIdx ? "A" : hunk.agreement === bIdx ? "B" : hunk.agreement === cIdx ? "C" : null;
    regions.push({
      pos,
      diffState: threeWay ? comparisonState : ["default-A", "prefer-A"].includes(stateOfMerge) ? "B" : "A",
    });
    merge.push({ state: stateOfMerge, ancestorEmpty: cOrAnc[0] === cOrAnc[1] });
  }
  setDiffOverlays(s, regions);
  if (s.isMerge) s.merge = merge;
}

// Positions of regions.

function diffPosition(s: Session, t: BufType, pos: "beg" | "end", n = s.current): number {
  if (n < 0 || n >= s.count) {
    if (s.count > 0) e8.signal("error", `${e8.thisCommand() ?? "nil"}: Bad diff region number, ${n + 1}.  Valid numbers are 1 to ${s.count}`);
    e8.signal("error", NO_DIFFERENCES);
  }
  const overlay = s.diffs[t][n]?.overlay;
  const at = overlay === undefined ? undefined : pos === "beg" ? ovStart(overlay) : ovEnd(overlay);
  if (at === undefined) e8.signal("error", KILLED_VITAL_BUFFER);
  return at!;
}

function regionContents(s: Session, n: number, t: BufType, start?: number, end?: number): string {
  const b = start ?? diffPosition(s, t, "beg", n);
  const e = end ?? diffPosition(s, t, "end", n);
  return withBuffer(s.buffers[t], () => e8.bufferText(b, e));
}

const validDifference = (s: Session, n = s.current) => n >= 0 && n < s.count;

function emptyRegion(s: Session, n: number, t: BufType): boolean {
  if (t === "C") return !s.is3wayComparison || diffPosition(s, "C", "beg", n) === diffPosition(s, "C", "end", n);
  return diffPosition(s, t, "beg", n) === diffPosition(s, t, "end", n);
}

function whitespaceRegion(s: Session, n: number, t: BufType): boolean {
  if ((t === "C" && !s.is3way) || emptyRegion(s, n, t)) return true;
  const end = diffPosition(s, t, "end", n);
  const begin = diffPosition(s, t, "beg", n);
  return withBuffer(s.buffers[t], () =>
    e8.saveExcursion(() => {
      e8.gotoChar(begin);
      e8.skipCharsForward(String(e8.bufferLocalValue("ediff-whitespace", s.control)));
      return e8.point() >= end;
    }),
  );
}

// Fine differences.

/** Move over one word of ediff's four kinds, as ediff-forward-word. */
function forwardWord(words: string[]): void {
  const start = e8.point();
  if (e8.skipCharsForward(words[0]) + e8.skipSyntaxForward("w") > 0) return;
  for (const set of words.slice(1)) {
    if (e8.skipCharsForward(set) > 0) return;
  }
  if (e8.point() === start && e8.point() < e8.pointMax()) e8.gotoChar(start + 1);
}

/**
 * The words of a region, as ediff-wordify splits it: each word's start and
 * end in the buffer, and the text with a word a line for diff.
 */
function wordify(s: Session, t: BufType, n: number): { spans: [number, number][]; text: string } {
  const begin = diffPosition(s, t, "beg", n);
  const end = diffPosition(s, t, "end", n);
  const text = withBuffer(s.buffers[t], () => e8.bufferSubstringNoProperties(begin, end));
  const words = ["ediff-word-1", "ediff-word-2", "ediff-word-3", "ediff-word-4"].map((v) => String(e8.bufferLocalValue(v, s.control)));
  const whitespace = String(e8.bufferLocalValue("ediff-whitespace", s.control));
  const tmp = e8.getBufferCreate(String(e8.variable("ediff-tmp-buffer")));
  return e8.withCurrentBuffer(tmp, () => {
    e8.setSyntaxTable(s.syntaxTable);
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.insert(text);
    e8.gotoChar(e8.pointMin());
    e8.skipCharsForward(whitespace);
    const spans: [number, number][] = [];
    while (e8.point() < e8.pointMax()) {
      const from = e8.point();
      forwardWord(words);
      spans.push([from, e8.point()]);
      e8.skipCharsForward(whitespace);
    }
    const out = spans.map(([a, b]) => e8.bufferText(a, b) + "\n").join("");
    return { spans: spans.map(([a, b]) => [a + begin, b + begin] as [number, number]), text: out };
  });
}

function clearFineDiffs(s: Session, n: number): void {
  for (const t of BUF_TYPES) {
    const record = s.diffs[t][n];
    if (record === undefined) continue;
    for (const o of record.fine ?? []) ovDelete(o);
    record.fine = null;
  }
}

/** Set fine-difference overlays from word-number hunks, as ediff-set-fine-overlays-in-one-buffer. */
function setFineOverlays(s: Session, t: BufType, n: number, hunks: ([number, number] | null)[], spans: [number, number][]): void {
  const record = s.diffs[t][n];
  for (const o of record.fine ?? []) ovDelete(o);
  const regionEnd = diffPosition(s, t, "end", n);
  const overlays: Ov[] = [];
  for (const words of hunks) {
    if (words === null) continue;
    const [first, after] = words;
    const begin = first <= spans.length ? spans[first - 1][0] : regionEnd;
    const end = after > first ? spans[Math.min(after - 1, spans.length) - 1][1] : begin;
    overlays.push(bulletProofOverlay(s.buffers[t]!, begin, end));
  }
  record.fine = overlays;
}

/** Compute the fine differences of region n, as ediff-make-fine-diffs. */
function makeFineDiffs(s: Session, n = s.current, flag?: "noforce" | "skip"): void {
  if (s.count < 1) e8.signal("error", NO_DIFFERENCES);
  if (n < 0 || n >= s.count) return;
  const types: BufType[] = s.is3way ? ["A", "B", "C"] : ["A", "B"];
  const empty = Object.fromEntries((["A", "B", "C"] as BufType[]).map((t) => [t, emptyRegion(s, n, t)])) as Record<BufType, boolean>;
  const white = Object.fromEntries((["A", "B", "C"] as BufType[]).map((t) => [t, whitespaceRegion(s, n, t)])) as Record<BufType, boolean>;
  const recordA = s.diffs.A[n];
  if ([empty.A, empty.B, empty.C].filter(Boolean).length > 1) {
    if (s.is3wayComparison) {
      messageIfVerbose(`Region ${n + 1} is empty in all buffers but ${!empty.A ? "A" : !empty.B ? "B" : "C"}`);
    } else {
      messageIfVerbose(`Region ${n + 1} in buffer ${empty.A ? "A" : empty.B ? "B" : "C"} is empty`);
    }
    recordA.noFineDiffs = white.A && white.B && white.C;
  } else if (flag === "noforce" && recordA.fine !== null) {
    const no = recordA.noFineDiffs;
    if (no) {
      const where = no === "A" ? "in buffers B & C" : no === "B" ? "in buffers A & C" : no === "C" ? "in buffers A & B" : "";
      e8.message(`Only white-space differences in region ${n + 1} ${where}`);
    }
  } else if (flag === "skip") {
    const refine = symbolName(e8.bufferLocalValue("ediff-auto-refine", s.control));
    if (recordA.fine === null && refine !== "off" && refine !== "nix") {
      messageIfVerbose(`Region ${n + 1} exceeds the auto-refinement limit. Type ‘*’ to refine`);
    }
  } else {
    messageIfVerbose(`Refining difference region ${n + 1} ...`);
    const words = Object.fromEntries(types.map((t) => [t, wordify(s, t, n)])) as Record<BufType, { spans: [number, number][]; text: string }>;
    const files = Object.fromEntries(types.map((t) => [t, e8.makeTempFile(`fineDiff${t}`, { text: words[t].text })])) as Record<BufType, string>;
    if (!live(s.fineDiffBuffer)) s.fineDiffBuffer = e8.getBufferCreate(uniqueBufferName("*ediff-fine-diff", "*"));
    try {
      if (s.is3way) {
        // In merges C is never refined: diff3 compares A, B and B.
        const left: BufType | null = white.A ? "A" : white.B ? "B" : white.C || s.isMerge ? "C" : null;
        const f = (t: BufType) => (t === left ? undefined : files[t]);
        const fA = f("A") ?? f("B");
        const fB = f("B") ?? f("A");
        const fC = f("C") ?? fB;
        execProcess(String(e8.variable("ediff-diff3-program") ?? "diff3"), s.fineDiffBuffer, String(e8.variable("ediff-diff3-options") ?? ""), [fA, fB, fC]);
        prepareErrorList(s, DIFF3_OK_LINES, s.fineDiffBuffer);
        const hunks = parseDiff3(e8.withCurrentBuffer(s.fineDiffBuffer, () => e8.bufferText()));
        for (const [t, idx] of [["A", "1"], ["B", "2"], ["C", "3"]] as [BufType, string][]) {
          if (t === left) {
            setFineOverlays(s, t, n, [], words[t].spans);
          } else {
            setFineOverlays(s, t, n, hunks.map((h) => h.groups[idx] ?? null), words[t].spans);
          }
        }
      } else {
        execProcess(String(e8.variable("ediff-diff-program") ?? "diff"), s.fineDiffBuffer, String(e8.variable("ediff-diff-options") ?? ""), [files.A, files.B]);
        prepareErrorList(s, DIFF_OK_LINES, s.fineDiffBuffer);
        const hunks = parseDiff(e8.withCurrentBuffer(s.fineDiffBuffer, () => e8.bufferText()));
        setFineOverlays(s, "A", n, hunks.map((h) => h.a), words.A.spans);
        setFineOverlays(s, "B", n, hunks.map((h) => h.b), words.B.spans);
      }
    } finally {
      for (const t of types) deleteFileQuietly(files[t]);
    }
    if (verbose()) clearMessage();
    const length =
      (s.diffs.A[n].fine?.length ?? 0) + (s.diffs.B[n].fine?.length ?? 0) + (s.is3way && !s.isMerge ? s.diffs.C[n].fine?.length ?? 0 : 0);
    if ((white.A && white.B && white.C) || (!white.A && !white.B && !(s.is3way && white.C) && length === 0)) {
      recordA.noFineDiffs = true;
      messageIfVerbose(`Only white-space differences in region ${n + 1}`);
    } else if (length === 0) {
      const t: BufType = white.A ? "A" : white.B ? "B" : "C";
      recordA.noFineDiffs = t;
      messageIfVerbose(`Only white-space differences in region ${n + 1} ${t === "A" ? "in buffers B & C" : t === "B" ? "in buffers A & C" : "in buffers A & B"}`);
    } else {
      recordA.noFineDiffs = null;
    }
  }
  setFineDiffProperties(s, n);
}

/** Give region n's fine differences their faces, or take them off, as ediff-set-fine-diff-properties. */
function setFineDiffProperties(s: Session, n: number, off = false): void {
  if (!validDifference(s, n)) return;
  for (const t of s.is3way ? (["A", "B", "C"] as BufType[]) : (["A", "B"] as BufType[])) {
    for (const o of s.diffs[t][n]?.fine ?? []) ovPut(o, "face", off ? null : `ediff-fine-diff-${t}`);
  }
}

/** Refine region n if ediff-auto-refine says to and it is small enough, as ediff-install-fine-diff-if-necessary. */
function installFineDiffIfNecessary(s: Session, n: number): void {
  const refine = symbolName(e8.bufferLocalValue("ediff-auto-refine", s.control));
  if (refine === "on" && truthy(e8.variable("ediff-use-faces"))) {
    const limit = Number(e8.bufferLocalValue("ediff-auto-refine-limit", s.control) ?? 14000);
    const small = (t: BufType) => limit > diffPosition(s, t, "end", n) - diffPosition(s, t, "beg", n);
    makeFineDiffs(s, n, small("A") && small("B") ? "noforce" : "skip");
  } else if (refine === "off") {
    makeFineDiffs(s, n, "skip");
  }
}

// Highlighting.

function highlightDiff(s: Session, n: number): void {
  for (const t of BUF_TYPES) {
    const buffer = s.buffers[t];
    const overlay = s.currentOverlay[t];
    if (!live(buffer) || overlay === undefined || s.diffs[t][n] === undefined) continue;
    const begin = diffPosition(s, t, "beg", n);
    const end = diffPosition(s, t, "end", n);
    const last = e8.withCurrentBuffer(buffer, () => e8.pointMax());
    ovMove(overlay, begin, Math.min(last, end + (begin === end ? 1 : 0)));
    ovPut(overlay, "ediff-diff-num", n);
    ovPut(s.diffs[t][n].overlay, "face", null);
  }
}

function unhighlightDiff(s: Session): void {
  for (const t of BUF_TYPES) {
    const overlay = s.currentOverlay[t];
    if (!live(s.buffers[t]) || overlay === undefined) continue;
    ovMove(overlay, 0, 0);
    const record = s.diffs[t][s.current];
    if (record !== undefined) ovPut(record.overlay, "face", highlightAll() ? backgroundFace(t, s.current) : null);
  }
}

function paintBackground(s: Session, off = false): void {
  for (const t of BUF_TYPES) {
    s.diffs[t].forEach((record, n) => {
      if (ovStart(record.overlay) !== undefined) ovPut(record.overlay, "face", off ? null : backgroundFace(t, n));
    });
  }
}

function selectDifference(s: Session, n: number): void {
  if (!live(s.buffers.A) || !live(s.buffers.B) || !validDifference(s, n)) return;
  if (truthy(e8.variable("ediff-use-faces"))) highlightDiff(s, n);
  installFineDiffIfNecessary(s, n);
  s.current = n;
  publish(s);
  e8.withCurrentBuffer(s.control, () => e8.runHooks("ediff-select-hook"));
}

function unselectDifference(s: Session, n: number): void {
  if (!validDifference(s, n)) return;
  if (truthy(e8.variable("ediff-use-faces"))) unhighlightDiff(s);
  setFineDiffProperties(s, s.current, true);
  e8.withCurrentBuffer(s.control, () => e8.runHooks("ediff-unselect-hook"));
}

/** Unselect the current region and select n, as ediff-unselect-and-select-difference. */
function unselectAndSelectDifference(s: Session, n: number, flag?: "select-only" | "unselect-only", noRecenter = false): void {
  if (!noRecenter) {
    const was = s.current;
    s.current = n;
    try {
      recenter(s, true);
    } finally {
      s.current = was;
    }
  }
  try {
    if (flag !== "select-only") unselectDifference(s, s.current);
    if (flag !== "unselect-only") selectDifference(s, n);
    s.current = n;
    publish(s);
  } finally {
    refreshModeLines(s);
  }
}

function restoreHighlighting(s: Session): void {
  if (highlightAll()) paintBackground(s);
  selectDifference(s, s.current);
}

// Windows.

const splitSide = (fn: e8.Value | undefined): "below" | "right" => (symbolName(fn) === "split-window-horizontally" ? "right" : "below");

/** The windows as they are now, to tell whether they must be laid out again, as ediff-window-config-saved. */
function windowConfig(s: Session): string {
  return JSON.stringify([s.windows, symbolName(ctlVar(s, "ediff-split-window-function")), truthy(ctlVar(s, "ediff-use-long-help-message"))]);
}

/** Whether the windows still show the session as they were laid out, as ediff-keep-window-config. */
function keepWindowConfig(s: Session): boolean {
  const shows = (t: BufType | "control") => {
    const w = s.windows[t];
    const b = t === "control" ? s.control : s.buffers[t];
    return windowLive(w) && e8.windowBuffer(w) === b?.name;
  };
  if (!shows("A") || !shows("B") || !shows("control")) return false;
  if (s.is3way && !shows("C")) return false;
  return s.configSaved === windowConfig(s);
}

function setupWindows(s: Session): void {
  e8.withCurrentBuffer(s.control, () => e8.runHooks("ediff-before-setup-windows-hook"));
  if (!keepWindowConfig(s)) {
    // As the plain setups bind window-min-height to 1 while they split.
    e8.letBind({ "window-min-height": 1 }, () => (s.isMerge ? setupWindowsPlainMerge(s) : setupWindowsPlainCompare(s)));
  }
  e8.withCurrentBuffer(s.control, () => e8.runHooks("ediff-after-setup-windows-hook"));
}

/** Leave the minibuffer's window and make the selected one the only one, as the plain setups start. */
function startLayout(): number {
  if (e8.selectedWindow() === e8.minibufferWindow()) e8.selectWindow(e8.windowList()[0]);
  e8.call("delete-other-windows");
  e8.setWindowDedicatedP(undefined, false);
  return e8.selectedWindow();
}

/** Two or three variants split the frame, with the control panel below, as ediff-setup-windows-plain-compare. */
function setupWindowsPlainCompare(s: Session): void {
  const side = splitSide(ctlVar(s, "ediff-split-window-function"));
  const windA = startLayout();
  e8.setWindowBuffer(windA, s.buffers.A!);
  const windB = e8.splitWindow(windA, side);
  e8.setWindowBuffer(windB, s.buffers.B!);
  let windC: number | undefined;
  if (s.is3wayComparison) {
    windC = e8.splitWindow(windB, side);
    e8.setWindowBuffer(windC, s.buffers.C!);
  }
  // As window-combination-resize gives the variants equal shares.
  e8.balanceWindows();
  s.windows = { A: windA, B: windB, C: windC };
  const control = e8.splitRootWindow("below", -controlHeight(s));
  e8.selectWindow(control);
  setupControlBuffer(s);
  if (side === "below") equalizeHeights([windA, windB, ...(windC === undefined ? [] : [windC])]);
}

/** Share the lines of windows one above another equally, the lower ones taking any left over, as Emacs's splits do. */
function equalizeHeights(windows: number[]): void {
  const total = windows.reduce((sum, w) => sum + e8.windowSize(w)!.totalHeight, 0);
  windows.slice(0, -1).forEach((w, i) => {
    const want = Math.floor(total / windows.length) + (i >= windows.length - (total % windows.length) ? 1 : 0);
    e8.resizeWindow(w, want - e8.windowSize(w)!.totalHeight);
  });
}

/** A and B side by side above the merge buffer, beside the ancestor, with the control panel below, as ediff-setup-windows-plain-merge. */
function setupWindowsPlainMerge(s: Session): void {
  const side = splitSide(ctlVar(s, "ediff-split-window-function"));
  const top = startLayout();
  const control = e8.splitWindow(top, "below", e8.windowSize(top)!.totalHeight - controlHeight(s));
  const height = e8.windowSize(top)!.totalHeight;
  const share = Number(ctlVar(s, "ediff-merge-window-share") ?? 0.45);
  const mergeLines = Math.max(2, Math.round(height * share));
  e8.setWindowBuffer(top, s.buffers.A!);
  const windA = top;
  const windC = e8.splitWindow(windA, "below", Math.max(2, height - mergeLines));
  e8.setWindowBuffer(windC, s.buffers.C!);
  let windAncestor: number | undefined;
  if (truthy(e8.variable("ediff-show-ancestor")) && s.isMergeWithAncestor && live(s.buffers.Ancestor)) {
    windAncestor = e8.splitWindow(windC, side);
    e8.setWindowBuffer(windAncestor, s.buffers.Ancestor);
  }
  const windB = e8.splitWindow(windA, side);
  e8.setWindowBuffer(windB, s.buffers.B!);
  s.windows = { A: windA, B: windB, C: windC, Ancestor: windAncestor };
  e8.selectWindow(control);
  setupControlBuffer(s);
}

/** The help message for the session, long or brief, as ediff-set-help-message. */
function helpMessage(s: Session): string {
  if (!truthy(ctlVar(s, "ediff-use-long-help-message"))) return BRIEF_HELP;
  const body = s.isMerge ? LONG_HELP_MERGE : s.isDiff3 ? LONG_HELP_COMPARE3 : LONG_HELP_COMPARE2;
  return LONG_HELP_HEAD + body + LONG_HELP_TAIL;
}

/**
 * The lines the control window takes: its help message and mode line, to
 * at most half the frame, as fit-window-to-buffer gives it. The window is
 * split off at that size, as E8 does not resize windows below
 * window-min-height's four lines.
 */
function controlHeight(s: Session): number {
  const lines = helpMessage(s).split("\n").length;
  return Math.max(2, Math.min(lines + 1, Math.ceil(e8.frameHeight() / 2)));
}

/** Show the help message in the selected window, sized to it, and make it the control window, as ediff-setup-control-buffer. */
function setupControlBuffer(s: Session): void {
  const window = e8.selectedWindow();
  e8.setWindowDedicatedP(window, false);
  e8.setWindowBuffer(window, s.control);
  e8.withCurrentBuffer(s.control, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      const help = helpMessage(s);
      e8.insert(help);
      e8.runHooks("ediff-display-help-hook");
      // Centred, as ediff-indent-help-message.
      const lineLength = (help.split("\n")[truthy(ctlVar(s, "ediff-use-long-help-message")) ? 1 : 0] ?? "").length;
      const shift = Math.floor(Math.max(0, e8.windowSize(window)!.width - lineLength) / 2);
      if (shift > 0) {
        const indented = help
          .split("\n")
          .map((l) => " ".repeat(shift) + l)
          .join("\n");
        e8.deleteRegion(e8.pointMin(), e8.pointMax());
        e8.insert(indented);
      }
      e8.setBufferModified(false);
    });
    s.windows.control = window;
    e8.gotoChar(e8.pointMin());
    e8.skipCharsForward(String(e8.bufferLocalValue("ediff-whitespace", s.control)));
    e8.setWindowPoint(window, e8.point());
  });
  s.configSaved = windowConfig(s);
  e8.setWindowDedicatedP(window, true);
  refreshModeLines(s);
  publish(s);
}

/** Show region beg-end in the selected window, centred if it fits, with point at pos, as ediff-position-region. */
function positionRegion(beg: number, end: number, pos: number): void {
  const window = e8.selectedWindow();
  end = Math.min(end, e8.pointMax());
  const height = e8.windowSize(window)!.totalHeight;
  const body = e8.windowSize(window)!.height;
  const lines = e8.lineOf(end) - e8.lineOf(beg) + (end > e8.lineStart(e8.lineOf(end)) ? 1 : 0);
  let start = beg;
  if (lines < body) {
    const line = Math.floor((1 + Math.max(height - 1 - lines, 1)) / 2);
    start = e8.lineStart(Math.max(e8.lineOf(e8.pointMin()), e8.lineOf(beg) - line));
    start = Math.max(start, e8.pointMin());
  }
  e8.setWindowStart(window, start);
  e8.gotoChar(pos);
  e8.setWindowPoint(window, pos);
}

function recenterOneWindow(s: Session, t: BufType): void {
  const window = s.windows[t];
  if (!validDifference(s) || !windowLive(window)) return;
  const control = e8.selectedWindow();
  e8.selectWindow(window);
  e8.withCurrentBuffer(s.buffers[t]!, () => {
    e8.deactivateMark();
    positionRegion(diffPosition(s, t, "beg"), diffPosition(s, t, "end"), diffPosition(s, t, "beg"));
  });
  e8.selectWindow(control);
}

/** Lay out the windows again and bring the current region into view in each, as ediff-recenter. */
function recenter(s: Session, noRehighlight = false): void {
  const allLive = live(s.buffers.A) && live(s.buffers.B) && (!s.is3way || live(s.buffers.C)) && (!s.isMergeWithAncestor || live(s.buffers.Ancestor));
  if (allLive) {
    setupWindows(s);
  } else if (e8.thisCommand() !== "ediff-quit") {
    e8.beep();
    e8.message(KILLED_VITAL_BUFFER);
  }
  if (live(s.buffers.A) && live(s.buffers.B) && (!s.is3way || live(s.buffers.C))) {
    if (!noRehighlight) selectDifference(s, s.current);
    recenterOneWindow(s, "A");
    recenterOneWindow(s, "B");
    if (s.is3way) recenterOneWindow(s, "C");
    if (live(s.buffers.Ancestor) && validDifference(s)) {
      const w = bufferWindow(s.buffers.Ancestor);
      if (w !== undefined) {
        const control = e8.selectedWindow();
        e8.selectWindow(w);
        e8.withCurrentBuffer(s.buffers.Ancestor, () => positionRegion(diffPosition(s, "Ancestor", "beg"), diffPosition(s, "Ancestor", "end"), diffPosition(s, "Ancestor", "beg")));
        e8.selectWindow(control);
      }
    }
  }
  if (!noRehighlight) restoreHighlighting(s);
  refreshModeLines(s);
}

// Mode lines.

function stateOfDiff(s: Session, n: number, t: BufType): string | null {
  return live(s.buffers.C) ? s.diffs[t][n]?.state ?? null : null;
}

/** Show the session's state in the mode lines, as ediff-refresh-mode-lines. */
function refreshModeLines(s: Session): void {
  let status: Partial<Record<BufType, string>> = { A: "", B: "", C: "" };
  let merge: string | null = null;
  if (validDifference(s)) {
    const n = s.current;
    merge = s.merge?.[n]?.state ?? null;
    const c = stateOfDiff(s, n, "C");
    status = {
      A: stateOfDiff(s, n, "A") ? `[${stateOfDiff(s, n, "A")}] ` : "",
      B: stateOfDiff(s, n, "B") ? `[${stateOfDiff(s, n, "B")}] ` : "",
      C:
        live(s.buffers.C) && (c || merge)
          ? `[${c ?? ""}${merge ? ` ${merge}` : ""}${s.merge?.[n]?.ancestorEmpty ? " AncestorEmpty" : ""}] `
          : "",
    };
  }
  const where =
    s.current < 0 ? `At start of ${s.count} diffs` : s.current >= s.count ? `At end of ${s.count} diffs` : `diff ${s.current + 1} of ${s.count}`;
  if (live(s.control)) {
    e8.withCurrentBuffer(s.control, () => {
      e8.setVariable("mode-line-format", [
        "-- ",
        e8.concat("%b   ", e8.propertize(where, { face: "mode-line-buffer-id" })),
        truthy(e8.variable("ediff-use-long-help-message")) ? "        Quick Help" : "",
      ]);
    });
  }
  for (const t of ["A", "B", "C"] as BufType[]) {
    if (t === "C" && !s.is3way) continue;
    const buffer = s.buffers[t];
    if (!live(buffer)) continue;
    e8.withCurrentBuffer(buffer, () => {
      if (!s.modeLines.has(buffer)) s.modeLines.set(buffer, e8.isLocalVariable("mode-line-format") ? e8.variable("mode-line-format") : undefined);
      const original = s.modeLines.get(buffer) ?? e8.defaultValue("mode-line-format");
      e8.setVariable("ediff-diff-status", status[t] ?? "");
      e8.setVariable("mode-line-format", [` ${t}: `, e8.intern("ediff-diff-status"), original ?? ""]);
    });
  }
  const ancestor = s.buffers.Ancestor;
  if (live(ancestor)) {
    e8.withCurrentBuffer(ancestor, () => {
      if (!s.modeLines.has(ancestor)) s.modeLines.set(ancestor, e8.isLocalVariable("mode-line-format") ? e8.variable("mode-line-format") : undefined);
      const original = s.modeLines.get(ancestor) ?? e8.defaultValue("mode-line-format");
      const prefer = merge?.includes("prefer-A") ? "[=diff(B)] " : merge?.includes("prefer-B") ? "[=diff(A)] " : "";
      e8.setVariable("mode-line-format", [" Ancestor: ", prefer, original ?? ""]);
    });
  }
}

/** Put back the variants' mode lines, as ediff-really-quit does. */
function restoreModeLines(s: Session): void {
  for (const [buffer, value] of s.modeLines) {
    if (!buffer.live) continue;
    e8.withCurrentBuffer(buffer, () => {
      if (value === undefined) e8.killLocalVariable("mode-line-format");
      else e8.setVariable("mode-line-format", value);
      e8.killLocalVariable("ediff-diff-status");
    });
  }
  s.modeLines.clear();
}

// Setting up.

const MERGE_JOBS = ["ediff-merge-files", "ediff-merge-buffers", "ediff-merge-files-with-ancestor", "ediff-merge-buffers-with-ancestor", "ediff-merge-revisions", "ediff-merge-revisions-with-ancestor"];
const ANCESTOR_JOBS = ["ediff-merge-files-with-ancestor", "ediff-merge-buffers-with-ancestor", "ediff-merge-revisions-with-ancestor"];

e8.defineMajorMode({
  name: "ediff-mode",
  modeName: "Ediff",
  doc:
    "The mode of an Ediff control panel, whose keys act on the buffers compared: n and p step through the regions " +
    "where they differ, j picks one by number, a and b copy the current region's text from one buffer to the other " +
    "and ra or rb put back what that replaced, wa and wb save a buffer, ! compares them again after editing, " +
    "| stacks the buffers or puts them side by side, ? lists every key, and q ends the session.",
  bindings: {
    p: "ediff-previous-difference",
    DEL: "ediff-previous-difference",
    "S-SPC": "ediff-previous-difference",
    n: "ediff-next-difference",
    SPC: "ediff-next-difference",
    j: "ediff-jump-to-difference",
    "g a": "ediff-jump-to-difference-at-point",
    "g b": "ediff-jump-to-difference-at-point",
    q: "ediff-quit",
    D: "ediff-show-diff-output",
    "C-l": "ediff-recenter",
    "|": "ediff-toggle-split",
    "?": "ediff-toggle-help",
    "!": "ediff-update-diffs",
    "*": "ediff-make-or-kill-fine-diffs",
    "@": "ediff-toggle-autorefine",
    "# #": "ediff-toggle-skip-similar",
    A: "ediff-toggle-read-only",
    B: "ediff-toggle-read-only",
    "w a": "ediff-save-buffer",
    "w b": "ediff-save-buffer",
    "w d": "ediff-save-buffer",
    "-": "negative-argument",
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [String(d), "digit-argument"])),
  } as unknown as Record<string, e8.CommandName>,
});

/** The keys that differ between the kinds of job, as ediff-setup-keymap binds them. */
function jobKeymap(s: Session): e8.Keymap {
  const map = e8.makeSparseKeymap("ediff-mode-map");
  const bind = (keys: string, command: string) => e8.defineKey(map, keys, command as e8.CommandName);
  if (s.isMerge) {
    bind("a", "ediff-copy-A-to-C");
    bind("b", "ediff-copy-B-to-C");
    bind("r", "ediff-restore-diff-in-merge-buffer");
    bind("+", "ediff-combine-diffs");
    bind("$ $", "ediff-toggle-show-clashes-only");
    bind("$ *", "ediff-toggle-skip-changed-regions");
    bind("&", "ediff-re-merge");
  } else if (s.is3wayComparison) {
    for (const [keys, command] of [
      ["a b", "ediff-copy-A-to-B"],
      ["b a", "ediff-copy-B-to-A"],
      ["a c", "ediff-copy-A-to-C"],
      ["b c", "ediff-copy-B-to-C"],
      ["c a", "ediff-copy-C-to-A"],
      ["c b", "ediff-copy-C-to-B"],
      ["r a", "ediff-restore-diff"],
      ["r b", "ediff-restore-diff"],
      ["r c", "ediff-restore-diff"],
      ["C", "ediff-toggle-read-only"],
    ]) {
      bind(keys, command);
    }
  } else {
    bind("a", "ediff-copy-A-to-B");
    bind("b", "ediff-copy-B-to-A");
    bind("r a", "ediff-restore-diff");
    bind("r b", "ediff-restore-diff");
  }
  if (s.is3way) {
    bind("w c", "ediff-save-buffer");
    bind("g c", "ediff-jump-to-difference-at-point");
  }
  return map;
}

/** Run a list of startup hooks: functions, or names of functions. */
function runFunctions(fns: e8.Value | undefined): void {
  const list = Array.isArray(fns) ? fns : fns === null || fns === undefined || fns === false ? [] : [fns];
  for (const f of list) {
    if (typeof f === "function" || typeof f === "string") e8.funcall(f);
    else if (typeof f === "symbol") e8.funcall(e8.symbolName(f));
  }
}

/**
 * Set up a session on buffers A, B and C, whose text is in the files given,
 * and return its control buffer, as ediff-setup. Startup hooks run in the
 * control buffer once it is ready; `mergeBufferFile` is where a merge's
 * result is to be saved.
 */
export function ediffSetup(
  bufferA: e8.BufferLike,
  fileA: string,
  bufferB: e8.BufferLike,
  fileB: string,
  bufferC: e8.BufferLike | null | undefined,
  fileC: string | null | undefined,
  startupHooks: e8.Value[],
  jobName: string,
  mergeBufferFile?: string | null,
): e8.Buffer {
  e8.runHooks("ediff-before-setup-hook");
  fileA = e8.expandFileName(fileA);
  fileB = e8.expandFileName(fileB);
  if (typeof fileC === "string") fileC = e8.expandFileName(fileC);
  if (typeof mergeBufferFile === "string") {
    mergeBufferFile = e8.expandFileName(mergeBufferFile);
    const dir = e8.fileNameDirectory(mergeBufferFile) ?? "/";
    if (!e8.fileExistsP(dir)) e8.signal("error", `Directory ${e8.abbreviateFileName(dir)} given as place to save the merge doesn’t exist`);
    if (e8.fileDirectoryP(mergeBufferFile)) e8.signal("error", `The merge buffer file ${e8.abbreviateFileName(mergeBufferFile)} must not be a directory`);
  }
  const A = e8.getBuffer(bufferA)!;
  const B = e8.getBuffer(bufferB)!;
  let C = bufferC === null || bufferC === undefined ? undefined : e8.getBuffer(bufferC);
  // Ediff's buffers start in the directory of the buffer it started from, as get-buffer-create's do in Emacs.
  const directory = e8.fileNameAsDirectory(e8.expandFileName("."));
  const control = e8.getBufferCreate(uniqueBufferName("*Ediff Control Panel", "*"));
  const isMerge = MERGE_JOBS.includes(jobName);
  const is3wayComparison = jobName === "ediff-files3" || jobName === "ediff-buffers3";
  const isMergeWithAncestor = ANCESTOR_JOBS.includes(jobName);
  const s: Session = {
    control,
    job: jobName,
    buffers: {},
    diffs: { A: [], B: [], C: [], Ancestor: [] },
    merge: null,
    current: -1,
    count: 0,
    currentOverlay: {},
    bounds: {},
    killed: new Map(),
    modeLines: new Map(),
    windows: {},
    configSaved: "",
    syntaxTable: "",
    is3wayComparison,
    isMerge,
    isMergeWithAncestor,
    is3way: is3wayComparison || isMerge,
    isDiff3: is3wayComparison || isMergeWithAncestor,
  };
  e8.withCurrentBuffer(control, () => {
    e8.call("ediff-mode" as e8.DefinedCommand);
    e8.setVariable("default-directory", directory);
    sessions.set(control, s);
    e8.setVariable("ediff-job-name", e8.intern(jobName));
    e8.setVariable("ediff-3way-comparison-job", is3wayComparison);
    e8.setVariable("ediff-merge-job", isMerge);
    e8.setVariable("ediff-merge-with-ancestor-job", isMergeWithAncestor);
    e8.setVariable("ediff-3way-job", s.is3way);
    e8.setVariable("ediff-diff3-job", s.isDiff3);
    for (const name of ["ediff-use-long-help-message", "ediff-split-window-function", "ediff-keep-variants", "ediff-merge-window-share"]) {
      e8.makeLocalVariable(name);
    }
    e8.setVariable("window-min-height", 2);
    // Never kill the variants of a buffer job without asking: work could be lost.
    if (jobName.includes("buffer")) e8.setVariable("ediff-keep-variants", true);
    if (isMerge) {
      const from = symbolName(e8.variable("ediff-default-variant")) === "default-B" ? B : A;
      e8.setVariable("ediff-split-window-function", e8.variable("ediff-merge-split-window-function") ?? "split-window-horizontally");
      s.buffers.Ancestor = C;
      C = e8.getBufferCreate(uniqueBufferName("*ediff-merge", "*"));
      const mode = e8.bufferLocalValue("major-mode", from);
      e8.withCurrentBuffer(C, () => {
        e8.insertBufferSubstring(from);
        e8.gotoChar(e8.pointMin());
        if (typeof mode === "string" && mode !== "fundamental-mode" && e8.commandExists(mode)) e8.call(mode as e8.CommandName);
        e8.setVariable("default-directory", directory);
        e8.widen();
      });
    }
    s.buffers.A = A;
    s.buffers.B = B;
    s.buffers.C = C;
    e8.setVariable("ediff-buffer-A", A);
    e8.setVariable("ediff-buffer-B", B);
    e8.setVariable("ediff-buffer-C", C ?? null);
    e8.setVariable("ediff-ancestor-buffer", s.buffers.Ancestor ?? null);
    e8.setVariable("ediff-control-buffer", control);
    e8.setVariable("ediff-control-frame", null);
    // As ediff-choose-syntax-table: A's, unless it is plain text.
    const modeA = e8.bufferLocalValue("major-mode", A);
    s.syntaxTable = ["fundamental-mode", "text-mode"].includes(String(modeA))
      ? e8.withCurrentBuffer(B, () => e8.syntaxTable())
      : e8.withCurrentBuffer(A, () => e8.syntaxTable());
    s.errorBuffer = e8.getBufferCreate(uniqueBufferName("*ediff-errors", "*"));
    e8.setVariable("ediff-error-buffer", s.errorBuffer);
    for (const t of ["A", "B", "C"] as BufType[]) {
      const b = s.buffers[t];
      if (live(b)) s.bounds[t] = e8.withCurrentBuffer(b, () => bulletProofOverlay(b, e8.pointMin(), e8.pointMax()));
    }
    e8.useLocalMap(jobKeymap(s));
    e8.runHooks("ediff-keymap-setup-hook");
    for (const t of ["A", "B"] as BufType[]) {
      e8.withCurrentBuffer(s.buffers[t]!, () => {
        e8.runHooks("ediff-prepare-buffer-hook");
        if (isMerge || truthy(e8.variable("ediff-make-buffers-readonly-at-startup"))) e8.setReadOnly(true);
      });
    }
    if (s.is3way && live(C)) {
      e8.withCurrentBuffer(C, () => {
        if (isMerge) e8.widen();
        e8.runHooks("ediff-prepare-buffer-hook");
        e8.setReadOnly(truthy(e8.variable("ediff-make-buffers-readonly-at-startup")));
      });
    }
    if (live(s.buffers.Ancestor)) {
      e8.withCurrentBuffer(s.buffers.Ancestor, () => {
        e8.setReadOnly(true);
        e8.runHooks("ediff-prepare-buffer-hook");
      });
    }
    if (s.isDiff3) setupDiffRegions3(s, fileA, fileB, fileC!);
    else setupDiffRegions(s, fileA, fileB);
    s.count = s.diffs.A.length;
    s.current = -1;
    e8.setVariable("ediff-diff-buffer", s.diffBuffer ?? null);
    for (const t of BUF_TYPES) {
      if ((t === "C" && !s.is3way) || (t === "Ancestor" && !isMergeWithAncestor)) continue;
      const b = s.buffers[t];
      if (!live(b)) continue;
      const end = e8.withCurrentBuffer(b, () => e8.pointMax());
      const o = bulletProofOverlay(b, end, end);
      ovPut(o, "face", `ediff-current-diff-${t}`);
      ovPut(o, "ediff", control);
      s.currentOverlay[t] = o;
    }
    publish(s);
  });
  setupWindows(s);
  for (const t of ["A", "B", "C"] as BufType[]) {
    if (t === "C" && !s.is3way) continue;
    const w = s.windows[t];
    if (windowLive(w)) {
      const start = regionsStart(s, t);
      e8.withCurrentBuffer(s.buffers[t]!, () => e8.gotoChar(start));
      e8.setWindowPoint(w, start);
    }
  }
  e8.selectWindow(s.windows.control!);
  e8.withCurrentBuffer(control, () => {
    runFunctions(startupHooks);
    arrangeAutosaveInMergeJobs(s, mergeBufferFile);
    refreshModeLines(s);
    e8.setReadOnly(true);
    e8.runHooks("ediff-startup-hook");
  });
  publish(s);
  return control;
}

/** Make the merge buffer visit the file to keep it in, as ediff-arrange-autosave-in-merge-jobs. */
function arrangeAutosaveInMergeJobs(s: Session, mergeBufferFile: string | null | undefined): void {
  if (!s.isMerge) return;
  if (typeof mergeBufferFile === "string") {
    e8.setVariable("ediff-autostore-merges", true);
    e8.setVariable("ediff-merge-store-file", mergeBufferFile);
  }
  const store = e8.variable("ediff-merge-store-file");
  if (typeof store === "string") {
    verifyFileMergeBuffer(store);
    withBuffer(s.buffers.C, () => e8.setVisitedFileName(store));
  }
}

/** Offer to save and kill another buffer visiting the merge's file, as ediff-verify-file-merge-buffer. */
function verifyFileMergeBuffer(file: string): void {
  const other = e8.bufferList().find((name) => e8.withCurrentBuffer(name, () => e8.bufferFileName()) === e8.expandFileName(file));
  if (other === undefined) return;
  if (e8.yOrNP(`Buffer ${other} is visiting ${file}. Save and kill the buffer? `)) {
    e8.withCurrentBuffer(other, () => e8.call("save-buffer"));
    e8.call("kill-buffer", other);
  } else {
    e8.signal("error", "Too dangerous to merge versions of a file visited by another buffer");
  }
}

/** Visit a file for Ediff, its buffer widened and in step with the file, as ediff-find-file. */
function findFile(file: string): e8.Buffer {
  if (!e8.fileReadableP(file)) e8.userError(`File ‘${file}’ does not exist or is not readable`);
  if (e8.fileDirectoryP(file)) e8.userError(`File ‘${file}’ is a directory`);
  file = e8.expandFileName(file);
  const name = e8.findFileNoselect(file);
  e8.withCurrentBuffer(name, () => {
    e8.widen();
    // As ediff-verify-file-buffer: a modified buffer is saved first, or the comparison stops.
    if (e8.visitedFileChanged()) {
      if (e8.yesOrNoP(`File ${file} was modified since visited by buffer ${name}.  REVERT file ${file}? `)) {
        e8.revertToVisitedFile();
      } else {
        e8.userError(`Buffer out of sync for file ${file}`);
      }
    } else if (e8.bufferModified()) {
      if (e8.yesOrNoP(`Buffer ${name} has been modified.  Save it in file ${file}?`)) {
        e8.call("save-buffer");
      } else {
        e8.userError(`Buffer is out of sync for file ${file}`);
      }
    }
  });
  return e8.getBuffer(name)!;
}

/** Compare or merge files, as ediff-files-internal. */
export function ediffFilesInternal(
  fileA: string,
  fileB: string,
  fileC: string | null | undefined,
  startupHooks: e8.Value[],
  jobName: string,
  mergeBufferFile?: string | null,
): e8.Buffer {
  if (fileA === fileB) e8.signal("error", "Files A and B are the same");
  if (typeof fileC === "string") {
    if (fileA === fileC) e8.signal("error", "Files A and C are the same");
    if (fileB === fileC) e8.signal("error", "Files B and C are the same");
  }
  e8.message(`Reading file ${fileA} ... `);
  const bufA = findFile(fileA);
  e8.message(`Reading file ${fileB} ... `);
  const bufB = findFile(fileB);
  let bufC: e8.Buffer | undefined;
  if (typeof fileC === "string") {
    e8.message(`Reading file ${fileC} ... `);
    bufC = findFile(fileC);
  }
  const fileOf = (b: e8.Buffer | undefined) => (b === undefined ? undefined : e8.withCurrentBuffer(b, () => e8.bufferFileName()));
  return ediffSetup(bufA, fileOf(bufA)!, bufB, fileOf(bufB)!, bufC ?? null, fileOf(bufC) ?? null, startupHooks, jobName, mergeBufferFile);
}

/**
 * Compare or merge buffers, through temporary files holding their text,
 * as ediff-buffers-internal: what magit-ediff.el calls.
 */
export function ediffBuffersInternal(
  bufA: e8.BufferLike,
  bufB: e8.BufferLike,
  bufC: e8.BufferLike | null | undefined,
  startupHooks: e8.Value[],
  jobName: string,
  mergeBufferFile?: string | null,
): e8.Buffer {
  const A = e8.getBuffer(bufA);
  const B = e8.getBuffer(bufB);
  const C = bufC === null || bufC === undefined ? undefined : e8.getBuffer(bufC);
  const show = (b: e8.BufferLike | null | undefined) => JSON.stringify(typeof b === "string" ? b : b?.name ?? null);
  if (!live(A)) e8.userError(`Buffer ${show(bufA)} doesn’t exist`);
  if (!live(B)) e8.userError(`Buffer ${show(bufB)} doesn’t exist`);
  if ((jobName === "ediff-files3" || jobName === "ediff-buffers3") && !live(C)) e8.userError(`Buffer ${show(bufC)} doesn’t exist`);
  const prefix = (b: e8.Buffer) => {
    const file = e8.withCurrentBuffer(b, () => e8.bufferFileName());
    return file === undefined ? undefined : e8.fileNameNondirectory(file);
  };
  const files: string[] = [];
  try {
    const fileA = makeTempFile(A!, prefix(A!));
    files.push(fileA);
    const fileB = makeTempFile(B!, prefix(B!));
    files.push(fileB);
    const fileC = live(C) ? makeTempFile(C, prefix(C)) : null;
    if (fileC !== null) files.push(fileC);
    return ediffSetup(A!, fileA, B!, fileB, live(C) ? C : null, fileC, startupHooks, jobName, mergeBufferFile);
  } finally {
    for (const f of files) deleteFileQuietly(f);
  }
}

const hooksArg = (hooks: e8.Value[] | undefined) => hooks ?? [];

/** Run Ediff on a pair of buffers, as ediff-buffers. */
export function ediffBuffers(bufferA: e8.BufferLike, bufferB: e8.BufferLike, startupHooks?: e8.Value[], jobName = "ediff-buffers"): e8.Buffer {
  return ediffBuffersInternal(bufferA, bufferB, null, hooksArg(startupHooks), jobName);
}

/** Run Ediff on three buffers, as ediff-buffers3. */
export function ediffBuffers3(bufferA: e8.BufferLike, bufferB: e8.BufferLike, bufferC: e8.BufferLike, startupHooks?: e8.Value[], jobName = "ediff-buffers3"): e8.Buffer {
  return ediffBuffersInternal(bufferA, bufferB, bufferC, hooksArg(startupHooks), jobName);
}

/** Run Ediff on a pair of files, as ediff-files. */
export function ediffFiles(fileA: string, fileB: string, startupHooks?: e8.Value[]): e8.Buffer {
  return ediffFilesInternal(fileA, e8.fileDirectoryP(fileB) ? e8.expandFileName(e8.fileNameNondirectory(fileA), fileB) : fileB, null, hooksArg(startupHooks), "ediff-files");
}

/** Run Ediff on three files, as ediff-files3. */
export function ediffFiles3(fileA: string, fileB: string, fileC: string, startupHooks?: e8.Value[]): e8.Buffer {
  const inDir = (f: string) => (e8.fileDirectoryP(f) ? e8.expandFileName(e8.fileNameNondirectory(fileA), f) : f);
  return ediffFilesInternal(fileA, inDir(fileB), inDir(fileC), hooksArg(startupHooks), "ediff-files3");
}

/** The startup hook of merges, which merges A and B into C, as ediff-merge-on-startup. */
const mergeOnStartup = e8.defun("ediff-merge-on-startup", () => doMerge(session(), 0));

/** Merge two files without ancestor, as ediff-merge-files. */
export function ediffMergeFiles(fileA: string, fileB: string, startupHooks?: e8.Value[], mergeBufferFile?: string | null): e8.Buffer {
  const inDir = (f: string) => (e8.fileDirectoryP(f) ? e8.expandFileName(e8.fileNameNondirectory(fileA), f) : f);
  return ediffFilesInternal(fileA, inDir(fileB), null, [mergeOnStartup, ...hooksArg(startupHooks)], "ediff-merge-files", mergeBufferFile);
}

/** Merge two files with ancestor, as ediff-merge-files-with-ancestor. */
export function ediffMergeFilesWithAncestor(fileA: string, fileB: string, fileAncestor: string, startupHooks?: e8.Value[], mergeBufferFile?: string | null): e8.Buffer {
  const inDir = (f: string) => (e8.fileDirectoryP(f) ? e8.expandFileName(e8.fileNameNondirectory(fileA), f) : f);
  return ediffFilesInternal(fileA, inDir(fileB), fileAncestor, [mergeOnStartup, ...hooksArg(startupHooks)], "ediff-merge-files-with-ancestor", mergeBufferFile);
}

/** Merge buffers without ancestor, as ediff-merge-buffers. */
export function ediffMergeBuffers(bufferA: e8.BufferLike, bufferB: e8.BufferLike, startupHooks?: e8.Value[], jobName = "ediff-merge-buffers", mergeBufferFile?: string | null): e8.Buffer {
  return ediffBuffersInternal(bufferA, bufferB, null, [mergeOnStartup, ...hooksArg(startupHooks)], jobName, mergeBufferFile);
}

/** Merge buffers with ancestor, as ediff-merge-buffers-with-ancestor: what Magit resolves conflicts with. */
export function ediffMergeBuffersWithAncestor(
  bufferA: e8.BufferLike,
  bufferB: e8.BufferLike,
  bufferAncestor: e8.BufferLike,
  startupHooks?: e8.Value[],
  jobName = "ediff-merge-buffers-with-ancestor",
  mergeBufferFile?: string | null,
): e8.Buffer {
  return ediffBuffersInternal(bufferA, bufferB, bufferAncestor, [mergeOnStartup, ...hooksArg(startupHooks)], jobName, mergeBufferFile);
}

// The entry commands, which take the place of ediff-hook.ts's.

/** A buffer argument, the default ediff-hook.ts's prompt offered for empty input. */
const bufferArg = (answer: string, earlier: string[]) => (answer === "" ? ediffOtherBuffer(earlier) : answer);

/** A file argument, as ediff-read-file-name finishes it: a directory names the default file in it. */
function fileArg(answer: string, earlier: string[], noDirs = false): string {
  const before = earlier[earlier.length - 1];
  const def = before === undefined ? e8.bufferFileName() : before;
  let f = e8.expandFileName(answer === "" ? def ?? "." : answer);
  if (e8.fileDirectoryP(f) && def !== undefined) f = e8.expandFileName(e8.fileNameNondirectory(def), f);
  if (noDirs && e8.fileDirectoryP(f)) e8.userError(`File ${f} is a directory`);
  return f;
}

const RUN: Record<string, (...args: string[]) => void> = {
  "ediff-files": (a, b) => {
    const fa = fileArg(a, [], true);
    ediffFiles(fa, fileArg(b, [fa]));
  },
  "ediff-files3": (a, b, c) => {
    const fa = fileArg(a, [], true);
    const fb = fileArg(b, [fa]);
    ediffFiles3(fa, fb, fileArg(c, [fb]));
  },
  "ediff-buffers": (a, b) => {
    const ba = bufferArg(a, []);
    ediffBuffers(ba, bufferArg(b, [ba]));
  },
  "ediff-buffers3": (a, b, c) => {
    const ba = bufferArg(a, []);
    const bb = bufferArg(b, [ba]);
    ediffBuffers3(ba, bb, bufferArg(c, [ba, bb]));
  },
  "ediff-merge-files": (a, b) => {
    const fa = fileArg(a, [], true);
    ediffMergeFiles(fa, fileArg(b, [fa]));
  },
  "ediff-merge-files-with-ancestor": (a, b, c) => {
    const fa = fileArg(a, [], true);
    const fb = fileArg(b, [fa]);
    ediffMergeFilesWithAncestor(fa, fb, fileArg(c, [fb]));
  },
  "ediff-merge-buffers": (a, b) => {
    const ba = bufferArg(a, []);
    ediffMergeBuffers(ba, bufferArg(b, [ba]));
  },
  "ediff-merge-buffers-with-ancestor": (a, b, c) => {
    const ba = bufferArg(a, []);
    const bb = bufferArg(b, [ba]);
    ediffMergeBuffersWithAncestor(ba, bb, bufferArg(c, [ba, bb]));
  },
};

for (const { name, doc, params } of ediffCommands) {
  e8.defineCommand({ name, doc, params, run: RUN[name] });
}

e8.defun("ediff-buffers-internal", (a: e8.BufferLike, b: e8.BufferLike, c: e8.BufferLike | null, hooks: e8.Value[], job: e8.Value, file?: string | null) =>
  ediffBuffersInternal(a, b, c, hooks ?? [], symbolName(job), file),
);
e8.defun("ediff-files-internal", (a: string, b: string, c: string | null, hooks: e8.Value[], job: e8.Value, file?: string | null) =>
  ediffFilesInternal(a, b, c, hooks ?? [], symbolName(job), file),
);
e8.defun("ediff-kill-buffer-carefully", (b: e8.BufferLike) => killBufferCarefully(b));
e8.defun("ediff-get-visible-buffer-window", (b: e8.BufferLike) => bufferWindow(e8.getBuffer(b)) ?? null);

// Moving between differences.

/** Whether a merge region agrees with the ancestor in one variant. */
function mergeRegionIsNonClash(s: Session, n: number): boolean {
  return !s.isMerge || (s.merge?.[n]?.state ?? "").includes("prefer");
}

/** Whether to skip a region in a merge, as ediff-show-clashes-only and ediff-skip-merge-regions-that-differ-from-default say. */
function skipRegion(s: Session, n: number): boolean {
  if (!s.isMerge) return false;
  if (truthy(ctlVar(s, "ediff-show-clashes-only")) && mergeRegionIsNonClash(s, n)) return true;
  return truthy(ctlVar(s, "ediff-skip-merge-regions-that-differ-from-default")) && mergeChangedFromDefault(s, n, true);
}

function skipSimilar(s: Session, n: number): boolean {
  if (!truthy(ctlVar(s, "ediff-ignore-similar-regions")) || !mergeRegionIsNonClash(s, n)) return false;
  const no = s.diffs.A[n].noFineDiffs;
  return no === true || (s.isMerge && no === "C");
}

function moveDifference(s: Session, step: number): void {
  let n = step > 0 ? Math.min(s.count, s.current + step) : Math.max(-1, s.current + step);
  const inRange = (k: number) => (step > 0 ? k < s.count : k > -1);
  let skip = inRange(n) && skipRegion(s, n);
  if (inRange(n) && !skip) installFineDiffIfNecessary(s, n);
  while (inRange(n) && (skip || skipSimilar(s, n))) {
    n += step > 0 ? 1 : -1;
    if (n % 20 === 0 && step > 0) e8.message(`Skipped over region ${n} and counting ...`);
    skip = inRange(n) && skipRegion(s, n);
    if (inRange(n) && !skip) installFineDiffIfNecessary(s, n);
  }
  clearMessage();
  unselectAndSelectDifference(s, n);
}

e8.defineCommand({
  name: "ediff-next-difference",
  doc: "Make the next region current, or the region that many on with a prefix argument, passing over those the skip options say to.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const s = session();
    if (s.current >= s.count) e8.userError("At end of the difference list");
    moveDifference(s, arg ?? 1);
  },
});

e8.defineCommand({
  name: "ediff-previous-difference",
  doc: "Make the region before the current one current, or the one that many back with a prefix argument.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const s = session();
    if (s.current <= -1) e8.userError("At beginning of the difference list");
    moveDifference(s, -(arg ?? 1));
  },
});

function jumpToDifference(s: Session, difference: number): void {
  const n = difference < 0 ? s.count + difference : difference > 0 ? difference - 1 : -1;
  if (n >= -1 && n <= s.count) unselectAndSelectDifference(s, n);
  else e8.signal("error", `${e8.thisCommand() ?? "nil"}: Bad diff region number, ${n + 1}.  Valid numbers are 1 to ${s.count}`);
}

e8.defineCommand({
  name: "ediff-jump-to-difference",
  doc: "Make the region the prefix argument numbers current, the first without one; a negative number counts back from the last.",
  params: [{ name: "difference-number", kind: "count" }],
  run: (n: number) => jumpToDifference(session(), n ?? 1),
});

/** The lines from one position to another, as count-lines counts them. */
function countLines(a: number, b: number): number {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (hi === lo) return 0;
  const text = e8.bufferText(lo, hi);
  return (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
}

/**
 * The region nearest a position in a buffer, point by default, numbered as
 * the user counts them, from 1, as ediff-diff-at-point: the one the
 * position is in, else the nearer of those before and after it.
 */
function diffAtPoint(s: Session, t: BufType, pos?: number): number {
  return withBuffer(s.buffers[t], () => {
    const at = pos ?? e8.point();
    // Emacs's positions start at 1, before which these start.
    let n = -1;
    let prevBeg = -1;
    let prevEnd = -1;
    let beg = -1;
    let end = -1;
    while ((at < prevBeg || at > beg) && n < s.count - 1) {
      n++;
      prevBeg = beg;
      prevEnd = end;
      beg = diffPosition(s, t, "beg", n);
      end = diffPosition(s, t, "end", n);
    }
    return countLines(at, Math.max(e8.pointMin(), prevEnd)) < countLines(at, Math.max(e8.pointMin(), beg)) ? n : n + 1;
  });
}

e8.defineCommand({
  name: "ediff-jump-to-difference-at-point",
  doc: "Make current the region nearest point in the buffer the key names: ga for A, gb for B, gc for C.",
  run: () => {
    const s = session();
    const t = charToBufType(e8.lastKey());
    if (s.count < 1) e8.signal("error", NO_DIFFERENCES);
    const n = diffAtPoint(s, t);
    jumpToDifference(s, n > s.count ? -1 : n);
  },
});

const charToBufType = (key: string | undefined): BufType => {
  const c = (key ?? "").slice(-1).toLowerCase();
  return c === "a" ? "A" : c === "b" ? "B" : "C";
};

// Copying and restoring.

/** Whether copying over region n of a buffer may go ahead, as ediff-test-save-region. */
function testSaveRegion(s: Session, n: number, t: BufType): boolean {
  if (s.killed.get(n)?.has(t)) {
    if (!e8.yesOrNoP(`You’ve previously copied diff region ${n + 1} to buffer ${t}.  Confirm? `)) e8.signal("error", "Quit");
  }
  return true;
}

function saveDiffRegion(s: Session, n: number, t: BufType, text: string): string {
  if (!s.killed.has(n)) s.killed.set(n, new Map());
  s.killed.get(n)!.set(t, text);
  return `Saving old diff region #${n + 1} of buffer ${t}.  To recover, type ‘r${s.isMerge ? "" : t.toLowerCase()}’`;
}

/** Copy region n from one buffer, or the text given, over another's, as ediff-copy-diff. */
function copyDiff(s: Session, n: number, from: BufType | null, to: BufType, batch = false, text?: string): void {
  const toBuffer = s.buffers[to];
  const begin = diffPosition(s, to, "beg", n);
  const end = diffPosition(s, to, "end", n);
  const copy = text ?? regionContents(s, n, from!);
  const replaced = regionContents(s, n, to, begin, end);
  let saved = true;
  let message = "";
  if (replaced === copy) {
    saved = false;
  } else if (batch || testSaveRegion(s, n, to)) {
    try {
      withBuffer(toBuffer, () => {
        e8.gotoChar(end);
        e8.insert(copy);
        if (end > begin) e8.deleteRegion(begin, end);
      });
      if (!batch) message = saveDiffRegion(s, n, to, replaced);
    } catch (e) {
      e8.message(`ediff-copy-diff: ${(e as Error).message}`);
      e8.beep();
      saved = false;
    }
  }
  if (saved && s.is3way) setStateOfDiffInAllBuffers(s, n);
  if (batch) {
    clearFineDiffs(s, n);
  } else {
    if (saved && s.is3way) clearFineDiffs(s, n);
    refreshModeLines(s);
    if (saved && !s.is3way) clearFineDiffs(s, n);
    e8.message(message);
  }
}

/** Copy the current region, or region ARG, from the buffer the first letter of KEYS names to the second's, as ediff-diff-to-diff. */
function diffToDiff(arg: e8.PrefixArg, keys: string): void {
  const s = session();
  const n = arg === "-" ? -1 : typeof arg === "number" ? arg : null;
  if (n !== null) jumpToDifference(s, n);
  e8.letBind({ "ediff-verbose-p": false }, () => copyDiff(s, s.current, charToBufType(keys[0]), charToBufType(keys[1])));
  recenter(s);
}

for (const [from, to] of [["A", "B"], ["B", "A"], ["A", "C"], ["B", "C"], ["C", "B"], ["C", "A"]]) {
  e8.defineCommand({
    name: `ediff-copy-${from}-to-${to}`,
    doc: `Replace buffer ${to}'s text in the current region with buffer ${from}'s, or in the region a numeric prefix argument names, keeping what it replaced for r${to.toLowerCase()} to put back.`,
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.PrefixArg) => diffToDiff(arg, `${from}${to}`.toLowerCase()),
  });
}

/** Put back what copying over region n of a buffer replaced, as ediff-pop-diff. */
function popDiff(s: Session, n: number, t: BufType): void {
  const saved = s.killed.get(n)?.get(t);
  if (saved === undefined) {
    if (s.count > 0) e8.userError(`Nothing saved for diff ${n + 1} in buffer ${t}`);
    e8.signal("error", NO_DIFFERENCES);
  }
  const begin = diffPosition(s, t, "beg", n);
  const end = diffPosition(s, t, "end", n);
  let recovered = false;
  try {
    withBuffer(s.buffers[t], () => {
      e8.gotoChar(end);
      e8.insert(saved!);
      if (end > begin) e8.deleteRegion(begin, end);
    });
    recovered = true;
  } catch (e) {
    e8.message(`ediff-pop-diff: ${(e as Error).message}`);
    e8.beep();
  }
  if (recovered) clearFineDiffs(s, n);
  if (recovered && s.is3way) setStateOfDiffInAllBuffers(s, n);
  refreshModeLines(s);
  if (recovered) {
    s.killed.get(n)!.delete(t);
    e8.message(`Diff region ${n + 1} in buffer ${t} restored`);
  }
}

function restoreDiff(arg: e8.PrefixArg, key?: string): void {
  const s = session();
  if (typeof arg === "number") jumpToDifference(s, arg);
  popDiff(s, s.current, charToBufType(key ?? e8.lastKey()));
  e8.letBind({ "ediff-verbose-p": false }, () => recenter(s));
}

e8.defineCommand({
  name: "ediff-restore-diff",
  doc: "Put back the text a copy replaced in the current region, or in the region a numeric prefix argument names, in the buffer the key names: ra for A, rb for B.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => restoreDiff(arg),
});

e8.defineCommand({
  name: "ediff-restore-diff-in-merge-buffer",
  doc: "Put back the merge buffer's text that a copy replaced in the current region, or the region a numeric prefix argument names.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => restoreDiff(arg, "c"),
});

// Three-way state and merging.

function setStateOfDiffInAllBuffers(s: Session, n: number): void {
  const a = regionContents(s, n, "A");
  const b = regionContents(s, n, "B");
  const c = regionContents(s, n, "C");
  const set = (t: BufType, v: string | null) => {
    if (s.diffs[t][n]) s.diffs[t][n].state = v;
  };
  if (a === b && a === c) {
    set("A", "=diff(B)");
    set("B", "=diff(C)");
    set("C", "=diff(A)");
  } else if (a === b) {
    set("A", "=diff(B)");
    set("B", "=diff(A)");
    set("C", null);
  } else if (a === c) {
    set("A", "=diff(C)");
    set("C", "=diff(A)");
    set("B", null);
  } else if (b === c) {
    set("C", "=diff(B)");
    set("B", "=diff(C)");
    set("A", null);
  } else if (s.isMerge && c === combinedRegion(s, n)) {
    set("A", null);
    set("B", null);
    set("C", "=diff(A+B)");
  } else {
    set("A", null);
    set("B", null);
    set("C", null);
  }
}

/** Regions A and B, and the ancestor's, between the delimiters of ediff-combination-pattern, as ediff-get-combined-region. */
function combinedRegion(s: Session, n: number): string {
  const pattern = ctlVar(s, "ediff-combination-pattern");
  const error = "ediff-combination-pattern: Invalid format. Please consult the documentation";
  if (!Array.isArray(pattern) || pattern.length < 5) e8.signal("error", error);
  const list = pattern as e8.Value[];
  let combined = "";
  let i = 0;
  for (; list.length - i > 2; i += 2) {
    const delim = list[i];
    const spec = symbolName(list[i + 1]);
    if (typeof delim !== "string" || !["A", "B", "Ancestor"].includes(spec)) e8.signal("error", error);
    // As ediff-get-combined-region, a region there is none of, as the
    // ancestor's without one, is left out with its delimiter.
    try {
      combined += `${delim as string}\n${regionContents(s, n, spec as BufType)}`;
    } catch {
      // Left out.
    }
  }
  if (typeof list[i] !== "string") e8.signal("error", error);
  return combined + `${list[i] as string}\n`;
}

/** Whether a merge region was changed since its default was put in, as ediff-merge-changed-from-default-p. */
function mergeChangedFromDefault(s: Session, n: number, prefersToo = false): boolean {
  const state = s.merge?.[n]?.state ?? "";
  const c = regionContents(s, n, "C");
  return (
    (state === "default-A" && regionContents(s, n, "A") !== c) ||
    (state === "default-B" && regionContents(s, n, "B") !== c) ||
    (state === "combined" && combinedRegion(s, n) !== c) ||
    (prefersToo && state === "prefer-A" && regionContents(s, n, "A") !== c) ||
    (prefersToo && state === "prefer-B" && regionContents(s, n, "B") !== c)
  );
}

/** Put each region from N on into C by its state of merge, as ediff-do-merge. */
function doMerge(s: Session, from: number, remerging = false): void {
  for (let n = Math.max(0, from); n < s.count; n++) {
    if (n % 10 === 0) e8.message(`${remerging ? "Re-merging" : "Merging"} buffers A & B into C ... region ${n} of ${s.count}`);
    let state = s.merge?.[n]?.state ?? "";
    let doNotCopy = false;
    if (remerging) {
      if (mergeChangedFromDefault(s, n) || state.includes("prefer")) doNotCopy = true;
      if (/default|combined/.test(state) && !doNotCopy) s.merge![n].state = symbolName(e8.variable("ediff-default-variant"));
    }
    state = s.merge?.[n]?.state ?? "";
    if (doNotCopy) continue;
    if (state === "combined") combineDiffs(s, n + 1, true);
    else copyDiff(s, n, state.includes("-A") ? "A" : "B", "C", true);
  }
  e8.message("Merging buffers A & B into C ... Done");
}

function combineDiffs(s: Session, n: number | null, batch = false): void {
  const region = n === null ? s.current : n - 1;
  copyDiff(s, region, null, "C", batch, combinedRegion(s, region));
  if (!batch) jumpToDifference(s, region + 1);
}

e8.defineCommand({
  name: "ediff-combine-diffs",
  doc: "Write A's and B's text of the current region into the merge buffer together, between the markers ediff-combination-pattern gives, or of the region a numeric prefix argument names.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n: e8.PrefixArg) => combineDiffs(session(), typeof n === "number" ? n : null),
});

e8.defineCommand({
  name: "ediff-re-merge",
  doc: "Ask for another ediff-default-variant and merge again with it the regions from the current one on that have not been edited or taken from one variant.",
  run: async () => {
    const s = session();
    const current = symbolName(e8.variable("ediff-default-variant"));
    const choices = ["default-A", "default-B", "combined"].filter((c) => c !== current);
    const answer = await e8.completingRead(`Current merge default is ‘${current}’.  New default: `, choices, { requireMatch: true });
    e8.setVariable("ediff-default-variant", e8.intern(answer));
    doMerge(s, s.current, true);
    recenter(s);
  },
});

for (const [name, variable, on, off] of [
  ["ediff-toggle-show-clashes-only", "ediff-show-clashes-only", "Focus on regions where both buffers differ from the ancestor", "Canceling focus on regions where changes clash"],
  ["ediff-toggle-skip-changed-regions", "ediff-skip-merge-regions-that-differ-from-default", "Skipping regions that differ from default setting", "Showing regions that differ from default setting"],
] as const) {
  e8.defineCommand({
    name,
    doc: `Turn ${variable} on or off when merging.`,
    run: () => {
      const s = session();
      if (name === "ediff-toggle-show-clashes-only" && !s.isMergeWithAncestor) e8.userError("This command makes sense only when merging with an ancestor");
      const value = !truthy(e8.variable(variable));
      e8.setVariable(variable, value);
      e8.message(value ? on : off);
    },
  });
}

// Other commands of the control panel.

e8.defineCommand({
  name: "ediff-recenter",
  doc: "Lay Ediff's windows out again and bring the current region into view in each.",
  run: () => recenter(session()),
});

e8.defineCommand({
  name: "ediff-toggle-split",
  doc: "Switch between the buffers compared one above another and side by side.",
  run: () => {
    const s = session();
    const fn = symbolName(e8.variable("ediff-split-window-function"));
    e8.setVariable("ediff-split-window-function", fn === "split-window-vertically" ? "split-window-horizontally" : "split-window-vertically");
    recenter(s, true);
  },
});

e8.defineCommand({
  name: "ediff-toggle-help",
  doc: "Show every key in the control panel, or only the line saying ? does.",
  run: () => {
    const s = session();
    e8.setVariable("ediff-use-long-help-message", !truthy(e8.variable("ediff-use-long-help-message")));
    s.configSaved = "";
    recenter(s, true);
  },
});

e8.defineCommand({
  name: "ediff-make-or-kill-fine-diffs",
  doc: "Split the current region into words and show those that differ; with a negative prefix argument, stop showing them.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    const s = session();
    if (arg === "-" || (typeof arg === "number" && arg < 0)) clearFineDiffs(s, s.current);
    else makeFineDiffs(s);
  },
});

e8.defineCommand({
  name: "ediff-toggle-autorefine",
  doc: "Go round ediff-auto-refine's settings: from on to off, from off to hiding the words that differ, and back to on.",
  run: () => {
    const s = session();
    const now = symbolName(e8.variable("ediff-auto-refine"));
    if (now === "nix") {
      e8.setVariable("ediff-auto-refine", e8.intern("on"));
      makeFineDiffs(s, s.current, "noforce");
      e8.message("Auto-refining is ON");
    } else if (now === "on") {
      e8.message("Auto-refining is OFF");
      e8.setVariable("ediff-auto-refine", e8.intern("off"));
    } else {
      setFineDiffProperties(s, s.current, true);
      e8.message("Refinements are HIDDEN");
      e8.setVariable("ediff-auto-refine", e8.intern("nix"));
    }
  },
});

e8.defineCommand({
  name: "ediff-toggle-skip-similar",
  doc: "Turn ediff-ignore-similar-regions on or off.",
  run: () => {
    session();
    const value = !truthy(e8.variable("ediff-ignore-similar-regions"));
    e8.setVariable("ediff-ignore-similar-regions", value);
    e8.message(value ? "Skipping regions that differ only in white space & line breaks" : "Skipping over white-space differences turned off");
  },
});

e8.defineCommand({
  name: "ediff-toggle-read-only",
  doc: "Make the buffer the key names, A, B or C, read-only, or writable if it was read-only.",
  run: () => {
    const s = session();
    const buffer = s.buffers[charToBufType(e8.lastKey())];
    withBuffer(buffer, () => e8.setReadOnly(!e8.bufferReadOnly()));
  },
});

e8.defineCommand({
  name: "ediff-show-diff-output",
  doc: "Show what ediff-custom-diff-program says of A and B, a context diff by default.",
  params: [{ name: "arg", kind: "prefix" }],
  run: () => {
    const s = session();
    computeCustomDiffs(s);
    const buffer = live(s.customDiffBuffer) ? s.customDiffBuffer : s.diffBuffer;
    if (!live(buffer)) e8.userError("Output from ‘diff’ not found");
    e8.call("display-buffer", buffer.name!);
  },
});

/** The custom diff of A and B into *ediff-custom-diff*, for D and wd, as ediff-compute-custom-diffs-maybe. */
function computeCustomDiffs(s: Session): void {
  const files: string[] = [];
  const fileFor = (t: BufType) => {
    const own = withBuffer(s.buffers[t], () => e8.bufferFileName());
    if (own !== undefined && e8.fileExistsP(own) && !withBuffer(s.buffers[t], () => e8.bufferModified())) return own;
    const tmp = makeTempFile(s.buffers[t]!);
    files.push(tmp);
    return tmp;
  };
  try {
    const fileA = fileFor("A");
    const fileB = fileFor("B");
    if (!live(s.customDiffBuffer)) s.customDiffBuffer = e8.getBufferCreate(uniqueBufferName("*ediff-custom-diff", "*"));
    execProcess(String(e8.variable("ediff-custom-diff-program") ?? "diff"), s.customDiffBuffer, String(e8.variable("ediff-custom-diff-options") ?? "-c"), [fileA, fileB]);
    e8.withCurrentBuffer(s.control, () => e8.setVariable("ediff-custom-diff-buffer", s.customDiffBuffer!));
  } finally {
    for (const f of files) deleteFileQuietly(f);
  }
}

e8.defineCommand({
  name: "ediff-save-buffer",
  doc: "Save the buffer the key names: wa A, wb B, wc C, and wd the diff of A and B, the plain diff the regions came from with a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    const s = session();
    const key = (e8.lastKey() ?? "").slice(-1);
    let buffer: e8.Buffer | undefined;
    if (key === "d") {
      computeCustomDiffs(s);
      e8.message("Saving diff output ...");
      buffer = arg !== null && live(s.diffBuffer) ? s.diffBuffer : live(s.customDiffBuffer) ? s.customDiffBuffer : s.diffBuffer;
      if (!live(buffer)) e8.userError("Output from ‘diff’ not found");
    } else {
      buffer = s.buffers[charToBufType(key)];
    }
    withBuffer(buffer, () => {
      // As basic-save-buffer asks for a file for a buffer that has none.
      if (e8.bufferFileName() === undefined && e8.bufferModified()) {
        const own = e8.variable("default-directory");
        const dir = typeof own === "string" ? own : e8.fileNameAsDirectory(e8.expandFileName("."));
        e8.setVisitedFileName(e8.expandFileName(e8.readFileName("File to save in: ", { dir }), dir));
      }
      e8.call("save-buffer");
    });
  },
});

e8.defineCommand({
  name: "ediff-update-diffs",
  doc: "Compare the buffers again as they are now, after editing them, and make current the region nearest point in A. Nothing is saved.",
  run: () => {
    const s = session();
    const pointA = withBuffer(s.buffers.A, () => e8.point());
    unselectAndSelectDifference(s, -1);
    const prefix = (t: BufType) => {
      const f = withBuffer(s.buffers[t], () => e8.bufferFileName());
      return f === undefined ? undefined : e8.fileNameNondirectory(f);
    };
    const files: Partial<Record<BufType, string>> = {};
    for (const t of BUF_TYPES) {
      if ((t === "C" && !s.is3way) || (t === "Ancestor" && !s.isMergeWithAncestor)) continue;
      files[t] = makeTempFile(s.buffers[t]!, prefix(t));
    }
    try {
      clearDiffVectors(s);
      s.killed.clear();
      if (s.isDiff3) setupDiffRegions3(s, files.A!, files.B!, s.isMergeWithAncestor ? files.Ancestor! : files.C!);
      else setupDiffRegions(s, files.A!, files.B!);
      s.count = s.diffs.A.length;
    } finally {
      for (const f of Object.values(files)) deleteFileQuietly(f);
    }
    if (s.is3way) for (let n = 0; n < s.count; n++) setStateOfDiffInAllBuffers(s, n);
    jumpToDifference(s, s.count > 0 ? diffAtPoint(s, "A", pointA) : 0);
    clearMessage();
  },
});

/** Delete the regions' overlays, as ediff-clear-diff-vector with fine-diffs-also. */
function clearDiffVectors(s: Session): void {
  for (const t of BUF_TYPES) {
    for (const record of s.diffs[t]) {
      ovDelete(record.overlay);
      for (const o of record.fine ?? []) ovDelete(o);
    }
    s.diffs[t] = [];
  }
}

// Quitting.

e8.defineCommand({
  name: "ediff-quit",
  doc:
    "End the session, after asking: the buffers compared get their mode lines back, and the control panel and Ediff's " +
    "other buffers go, the compared ones staying unless ediff-keep-variants is nil, which a prefix argument reverses.",
  params: [{ name: "reverse-default-keep-variants", kind: "prefix" }],
  run: (reverse: e8.PrefixArg) => {
    session();
    if (e8.yOrNP("Quit this Ediff session? ")) {
      clearMessage();
      e8.setThisCommand("ediff-quit" as e8.DefinedCommand);
      reallyQuit(reverse !== null);
    } else {
      clearMessage();
    }
  },
});

/** Leave the session, as ediff-really-quit. */
function reallyQuit(reverseKeepVariants: boolean): void {
  const s = session();
  unselectAndSelectDifference(s, -1, undefined, true);
  paintBackground(s, true);
  for (const t of BUF_TYPES) {
    const o = s.currentOverlay[t];
    if (o !== undefined) ovDelete(o);
  }
  s.currentOverlay = {};
  clearDiffVectors(s);
  for (const o of Object.values(s.bounds)) ovDelete(o);
  s.bounds = {};
  const afterQuit = (() => {
    const v = e8.variable("ediff-after-quit-hook-internal");
    return (Array.isArray(v) ? v : []).filter((f) => f !== true);
  })();
  restoreModeLines(s);
  if (s.isMerge) {
    e8.conditionCase(() => e8.runHooks("ediff-quit-merge-hook"), { quit: () => undefined });
  }
  e8.runHooks("ediff-cleanup-hook");
  const keep = truthy(e8.variable("ediff-keep-variants"));
  janitor(s, true, reverseKeepVariants ? !keep : keep);
  e8.runHooks("ediff-quit-hook");
  sessions.delete(s.control);
  runFunctions(afterQuit);
}

/** Kill the variant buffers that are unmodified, asking first, unless they are to be kept, as ediff-janitor. */
function janitor(s: Session, ask: boolean, keepVariants: boolean): void {
  const dispose = (buffer: e8.Buffer | undefined, t: BufType) => {
    if (!live(buffer) || keepVariants || e8.withCurrentBuffer(buffer, () => e8.bufferModified())) return;
    if (ask && !e8.yOrNP(`Kill buffer ${t} [${buffer.name}]? `)) return;
    killBufferCarefully(buffer);
  };
  dispose(s.buffers.A, "A");
  dispose(s.buffers.B, "B");
  if (s.isMerge) dispose(s.buffers.Ancestor, "Ancestor");
  else dispose(s.buffers.C, "C");
}

/** Kill the control buffer and Ediff's other buffers, and show the variants, as ediff-cleanup-mess. */
const cleanupMess = e8.defun("ediff-cleanup-mess", () => {
  const s = sessions.get(e8.bufferName());
  if (s === undefined) return;
  const ctlWindow = bufferWindow(s.control);
  for (const b of [s.diffBuffer, s.customDiffBuffer, s.fineDiffBuffer, s.errorBuffer]) killBufferCarefully(b);
  for (const name of [e8.variable("ediff-tmp-buffer"), e8.variable("ediff-msg-buffer"), e8.variable("ediff-debug-buffer")]) {
    if (typeof name === "string") killBufferCarefully(name);
  }
  if (ctlWindow !== undefined && e8.windowList().length > 1) e8.deleteWindow(ctlWindow);
  const { A, B, C } = s.buffers;
  const split = splitSide(e8.variable("ediff-split-window-function"));
  killBufferCarefully(s.control);
  if (live(B) && bufferWindow(B) === undefined) e8.call("switch-to-buffer", B.name!);
  if (live(A) && bufferWindow(A) === undefined) {
    if (bufferWindow(B) !== undefined) e8.selectWindow(e8.splitWindow(undefined, split));
    e8.call("switch-to-buffer", A.name!);
  }
  if (s.is3way && live(C) && bufferWindow(C) === undefined) {
    if (bufferWindow(A) !== undefined || bufferWindow(B) !== undefined) e8.selectWindow(e8.splitWindow(undefined, split));
    e8.call("switch-to-buffer", C.name!);
  }
  e8.balanceWindows();
  clearMessage();
});
e8.addHook("ediff-quit-hook", () => e8.funcall(cleanupMess));

/** Save the merge buffer and offer to kill it, as ediff-maybe-save-and-delete-merge, the default of ediff-quit-merge-hook. */
const maybeSaveAndDeleteMerge = e8.defun("ediff-maybe-save-and-delete-merge", (saveAndContinue?: boolean) => {
  const s = sessions.get(e8.bufferName());
  if (s === undefined) return;
  const autostore = saveAndContinue ? true : e8.variable("ediff-autostore-merges");
  if (!truthy(autostore)) return;
  const store = e8.variable("ediff-merge-store-file");
  if (typeof store === "string") {
    writeMergeBufferAndMaybeKill(s.buffers.C!, store, true, Boolean(saveAndContinue));
  } else if (autostore === true) {
    const file = e8.readFileName("Save the result of the merge in file: ");
    writeMergeBufferAndMaybeKill(s.buffers.C!, file, false, Boolean(saveAndContinue));
  }
});
e8.setDefault("ediff-quit-merge-hook", [maybeSaveAndDeleteMerge]);

function writeMergeBufferAndMaybeKill(buffer: e8.Buffer, file: string, showFile: boolean, saveAndContinue: boolean): void {
  file = e8.expandFileName(file);
  const visiting = e8.bufferList().find((name) => e8.withCurrentBuffer(name, () => e8.bufferFileName()) === file);
  if (visiting !== undefined && visiting !== buffer.name) {
    e8.beep();
    e8.message(`Another buffer is visiting file ${file}. Too dangerous to save the merge buffer`);
    return;
  }
  withBuffer(buffer, () => {
    if (e8.fileExistsP(file) && e8.bufferFileName() !== file && !e8.yOrNP(`File ${file} exists, overwrite? `)) return;
    e8.setVisitedFileName(file);
    e8.call("save-buffer");
    if (showFile) {
      e8.message(`Merge buffer saved in: ${file}`);
      e8.setBufferModified(false);
    }
  });
  if (!saveAndContinue && e8.yOrNP("Merge buffer saved.  Now kill the buffer? ")) killBufferCarefully(buffer);
}

