// Operations over several files, after Emacs's fileloop.el: a round of
// files to go through, a scan function that finds the next place in a
// file worth acting on, and an operate function acting there.
// fileloop-continue goes on after a round was left, as Dired's Q and
// project-query-replace-regexp leave theirs.

import { performReplaceUntilDone, resetMultiBuffer } from "replace";
import { revertBuffer } from "files";
import { truthy } from "subr";

e8.defineVariable({
  name: "fileloop-revert-buffers",
  doc:
    "Whether a round reverts buffers whose files changed on disk: silent only those revert-without-query names, " +
    "t asking about each, nil never.",
  value: "silent",
});

let files: string[] = [];
let scan: () => unknown = () => e8.userError("No operation in progress");
let operate: () => unknown = () => null;
let fresh = false;

/**
 * Starts a new round over `fileList`, as fileloop-initialize: `scanFn`,
 * called in each file's buffer from point, says whether there is anything
 * to act on; `operateFn` acts, and says whether to go on to the next file
 * at once.
 */
export function fileloopInitialize(fileList: string[], scanFn: () => unknown, operateFn: () => unknown): void {
  files = [...fileList];
  scan = scanFn;
  operate = operateFn;
  fresh = true;
}

const SCAN_BUFFER = " *next-file*";

/**
 * Goes to the round's next file, as fileloop-next-file: a buffer visiting
 * it, reverted first if fileloop-revert-buffers says; else, with
 * `novisit`, its text read into a scratch buffer to scan, and the file's
 * name given back so it is visited only if the scan finds something; else
 * the file visited. "All files processed" when none are left.
 */
function nextFile(novisit: boolean): string | undefined {
  const next = files.shift();
  if (next === undefined) {
    if (novisit && e8.getBuffer(SCAN_BUFFER)) e8.call("kill-buffer", SCAN_BUFFER);
    e8.userError("All files processed");
  }
  const existing = e8.getFileBuffer(next!);
  const how = e8.variable("fileloop-revert-buffers");
  if (existing && truthy(how) && !e8.verifyVisitedFileModtime(existing)) {
    const modified = e8.withCurrentBuffer(existing, () => e8.bufferModified());
    const revert =
      how === "silent"
        ? !modified && ((e8.variable("revert-without-query") as string[] | null) ?? []).some((re) => e8.stringMatch(re, next!) !== undefined)
        : e8.yOrNP(modified ? `File ${next} changed on disk.  Discard your edits? ` : `File ${next} changed on disk.  Reread from disk? `);
    // Asked once, as (revert-buffer t t) asks no more.
    if (revert) e8.withCurrentBuffer(existing, () => revertBuffer(true, true));
  }
  if (existing || !novisit) {
    e8.setBuffer(existing ?? e8.findFileNoselect(next!));
    return undefined;
  }
  e8.setBuffer(e8.getBufferCreate(SCAN_BUFFER));
  e8.killAllLocalVariables();
  e8.deleteRegion(e8.pointMin(), e8.pointMax());
  const read = e8.conditionCase(() => {
    e8.insertFileContents(next!);
    return true;
  }, { "file-missing": () => false });
  return read ? next : nextFile(novisit);
}

/**
 * Goes on with the round, as fileloop-continue: through the files, from
 * point in the current one, scanning those no buffer visits in a scratch
 * buffer, to the next place the scan finds, the file then visited and
 * shown in the selected window, where the operation runs, going on while
 * it says to.
 */
export function fileloopContinue(): void {
  let fresh_ = fresh;
  let finished = false;
  let original: number | undefined;
  let visiting: string | undefined;
  for (;;) {
    while (fresh_ || finished || !e8.saveRestriction(() => {
      e8.widen();
      return truthy(scan() as e8.Value);
    })) {
      // Nothing found in the last file: point goes back where it was.
      if (original !== undefined) e8.gotoChar(original);
      finished = false;
      visiting = nextFile(true);
      fresh = fresh_ = false;
      original = visiting === undefined ? e8.point() : undefined;
      e8.gotoChar(e8.pointMin());
    }
    if (visiting !== undefined) {
      // Found in the scratch buffer: the file is visited for real, at the same place.
      const pos = e8.point();
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      e8.setBuffer(e8.findFileNoselect(visiting));
      visiting = undefined;
      e8.widen();
      e8.gotoChar(pos);
    } else if (original !== undefined) {
      e8.pushMark(original);
    }
    // Shown with point where the scan left it, as fileloop binds
    // switch-to-buffer-preserve-window-point to nil.
    e8.letBind({ "switch-to-buffer-preserve-window-point": false }, () => e8.call("switch-to-buffer", e8.bufferName()));
    const goOn = e8.saveRestriction(() => {
      e8.widen();
      return truthy(operate() as e8.Value);
    });
    if (!goOn) return;
    finished = true;
    original = undefined;
  }
}

e8.defineCommand({
  name: "fileloop-continue",
  doc: "Go on with the last operation over several files, where it was left.",
  run: () => {
    // Asked again, as Y was the last key typed only within the run it was typed in.
    resetMultiBuffer();
    fileloopContinue();
  },
});

/** Whether a search folds case, as fileloop--case-fold: `caseFold` "default" as case-fold-search says, upper case in the regexp meaning no. */
function foldsCase(regexp: string, caseFold: boolean | "default"): boolean {
  const value = caseFold === "default" ? truthy(e8.variable("case-fold-search")) : caseFold;
  return value && truthy(e8.variable("search-upper-case")) ? e8.foldCaseFor(regexp, true) : value;
}

/** Starts a round finding `regexp` in the files, as fileloop-initialize-search. */
export function fileloopInitializeSearch(regexp: string, fileList: string[], caseFold: boolean | "default"): void {
  let last = e8.bufferName();
  fileloopInitialize(
    fileList,
    () => e8.reSearchForward(regexp, { noerror: true, caseFold: foldsCase(regexp, caseFold) }) !== undefined,
    () => {
      if (e8.bufferName() !== last) {
        last = e8.bufferName();
        e8.message(`Scanning file ${e8.bufferFileName() ?? last}...found`);
      }
      return false;
    },
  );
}

/**
 * Starts a round query-replacing `from`, a regexp, with `to` in the
 * files, as fileloop-initialize-replace: each file from its first match,
 * Y replacing in the rest without asking and N going on to the next file.
 */
export function fileloopInitializeReplace(from: string, to: string, fileList: string[], caseFold: boolean | "default", delimited = false): void {
  const starts = new Map<string, number>();
  resetMultiBuffer();
  fileloopInitialize(
    fileList,
    () => {
      const m = e8.reSearchForward(from, { noerror: true, caseFold: foldsCase(from, caseFold) });
      if (m === undefined) return false;
      starts.set(e8.bufferName(), e8.matchBeginning(0)!);
      return true;
    },
    () =>
      e8.letBind({ "case-fold-search": foldsCase(from, caseFold) }, () => {
        e8.deactivateMark();
        e8.gotoChar(starts.get(e8.bufferName()) ?? e8.pointMin());
        return performReplaceUntilDone(from, to, true, delimited);
      }),
  );
}
