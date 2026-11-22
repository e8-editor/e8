// Archiving, after Org's org-archive.el: C-c C-x C-s (or C-c $) moves the
// subtree at point to its archive location, by default a file next to this
// one named FILE_archive, with properties saying where it came from, or,
// with C-u, every tree with no open TODO, with C-u C-u every one dated
// before today; C-c C-x A moves it under an Archive sibling instead, and
// C-c C-x a toggles its ARCHIVE tag. With the region active, each acts on
// every heading in it.

import {
  allKeywords,
  clearMarkersToMove,
  copySubtree,
  entryGetInherited,
  forEachHeadingInRegion,
  formatTimestamp,
  type Heading,
  headingIndex,
  headings,
  isDone,
  keywordLines,
  notDoneRegexp,
  parseHeading,
  pasteSubtree,
  type RegionScope,
  setTodo,
  subtreeRegion,
  today,
  updateParentTodoStatistics,
  validLevel,
  withTheseTodoStates,
} from "org";
import { dateTreeRoot, findDateCreate } from "org-datetree";
import { elementAt } from "org-element";
import { ancestors, flag, showEmptyLines, showSetVisibility } from "org-fold";
import { entryPut } from "org-list";
import { dropMarker, lineAt, marker } from "org-macs";
import { regexpQuote, truthy } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar(
  "org-archive-location",
  "%s_archive::",
  'Where archived subtrees go, as FILE::HEADING: %s in either is this file\'s name; an empty FILE is this file, an empty HEADING the top level, and "datetree/" a date tree. A #+ARCHIVE: line or an ARCHIVE property says otherwise.',
);
defvar("org-archive-default-command", "org-archive-subtree", "The command C-c C-x C-a archives with.");
defvar("org-archive-reversed-order", null, "Whether an archived tree goes first under its archive heading rather than last.");
defvar("org-archive-sibling-heading", "Archive", "The heading of the sibling C-c C-x A archives under.");
defvar("org-archive-tag", "ARCHIVE", "The tag that marks a subtree archived where it is.");
defvar("org-archive-mark-done", null, "Whether an archived entry is marked done, or the done state to mark it with.");
defvar("org-archive-file-header-format", "\nArchived entries from file %s\n\n", "What a new archive file starts with, %s this file's name; nil for nothing.");
defvar("org-archive-subtree-add-inherited-tags", "infile", "Whether an archived subtree gets the tags it inherited: t, infile when archived in this file, or nil.");
defvar("org-archive-subtree-save-file-p", "from-org", "When the archive file is saved after archiving: t, from-org, from-agenda, or nil.");
defvar(
  "org-archive-save-context-info",
  ["time", "file", "olpath", "category", "todo", "itags"],
  "What an archived entry keeps of where it was, each as an ARCHIVE_ property: time, file, ltags, itags, todo, category and olpath.",
);
e8.defineHook("org-archive-hook", "Run in the archived subtree's buffer, before it is cut, after it is put in its archive.");

/** FMT with %s as NAME and %% as %, as format does with one string. */
const formatName = (fmt: string, name: string): string => fmt.replace(/%([%s])/g, (_m, c: string) => (c === "%" ? "%" : name));

/**
 * Copies or cuts the subtree at point, leaving this-command as it was, as
 * org-archive binds it around org-cut-subtree, so the next command's kill
 * starts afresh rather than appending to this one's.
 */
function subtreeKill(cut: boolean): void {
  const saved = e8.thisCommand();
  // A copy too keeps the markers in it, to go with it, as org-archive-subtree copies with force-store-markers.
  copySubtree(cut, 1, false, true);
  if (saved !== undefined) e8.setThisCommand(saved as e8.CommandName);
}

/** The heading the entry at point starts at, as org-back-to-heading, or the error before the first. */
function headingHere(): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) e8.userError(`Before first headline at position ${e8.lineStart(lineAt()) + 1} in buffer ${e8.bufferName()}`);
  return [all, i!];
}

/** The archive location's file and heading for this file, as org-archive--compute-location. */
function computeLocation(location: string, currentFile: string): [string, string] {
  const sep = location.indexOf("::");
  if (sep < 0) e8.signal("error", `Invalid archive location: ${JSON.stringify(location)}`);
  const name = e8.fileNameNondirectory(currentFile);
  const fileFmt = location.slice(0, sep);
  const headingFmt = location.slice(sep + 2);
  return [/\S/.test(fileFmt) ? e8.expandFileName(formatName(fileFmt, name)) : currentFile, formatName(headingFmt, name)];
}

/** The location a #+ARCHIVE: line sets, the first of them, as org-set-regexps-and-options reads a unique keyword. */
function keywordLocation(): string | undefined {
  for (const [, , text] of keywordLines()) {
    const m = /^#\+ARCHIVE:[ \t]*(.*?)[ \t]*$/i.exec(text);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * The archive files this buffer archives to that exist, as
 * org-all-archive-files: its archive location's, then each ARCHIVE
 * property's.
 */
function allArchiveFiles(): string[] {
  const current = e8.bufferFileName() ?? "";
  const files = [computeLocation(keywordLocation() ?? String(e8.variable("org-archive-location") ?? "%s_archive::"), current)[0]];
  e8.saveRestriction(() => {
    e8.widen();
    for (const [, start, text] of e8.matchingLines("^[ \t]*:ARCHIVE:", { caseFold: true, start: e8.pointMin(), end: e8.pointMax() })) {
      if (elementAt(start)?.type !== "node-property") continue;
      const value = /^[ \t]*:ARCHIVE:(?:[ \t]+(.*?))?[ \t]*$/i.exec(text)?.[1] ?? "";
      const [file] = computeLocation(value, current);
      if (/\S/.test(file) && !files.includes(file)) files.push(file);
    }
  });
  return files.filter((f) => e8.fileExistsP(f));
}

/** FILES with each one's archive files after it, those that exist, as org-add-archive-files. */
export function addArchiveFiles(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!e8.fileExistsP(f)) continue;
    for (const g of [f, ...e8.withCurrentBuffer(e8.findFileNoselect(f), allArchiveFiles)]) {
      if (!out.some((o) => e8.expandFileName(o) === e8.expandFileName(g))) out.push(g);
    }
  }
  return out;
}
e8.defun("org-add-archive-files", (files: string[]) => addArchiveFiles(Array.isArray(files) ? files.map(String) : []));

/** The tags of the file, as FILETAGS lines give them. */
function fileTags(): string[] {
  const out: string[] = [];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+FILETAGS:(.*)$/i.exec(text);
    if (m) for (const t of m[1].split(/[:\s]+/)) if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The heading's tags, inherited ones first, each where it comes last, as org-get-tags gives them, and which were inherited. */
function allTags(all: Heading[], i: number): { tags: string[]; inherited: string[]; local: string[] } {
  // None with org-use-tag-inheritance off, and not those org-tags-exclude-from-inheritance names.
  const exclude = e8.variable("org-tags-exclude-from-inheritance");
  const excluded = Array.isArray(exclude) ? exclude.map(String) : [];
  const itags = truthy(e8.variable("org-use-tag-inheritance") ?? true)
    ? [...fileTags(), ...ancestors(all, i).reverse().flatMap((a) => all[a].tags)].filter((t) => !excluded.includes(t))
    : [];
  const tagged = [...itags.map((t) => [t, true] as const), ...all[i].tags.map((t) => [t, false] as const)];
  const kept = tagged.filter(([t], j) => !tagged.slice(j + 1).some(([u]) => u === t));
  return { tags: kept.map(([t]) => t), inherited: kept.filter(([, x]) => x).map(([t]) => t), local: kept.filter(([, x]) => !x).map(([t]) => t) };
}

/** The entry's category, as org-get-category: its CATEGORY, inherited, else the file's #+CATEGORY or its name. */
function categoryOf(h: Heading, file: string): string {
  const own = entryGetInherited(h, "CATEGORY", false);
  if (own !== undefined) return own;
  let keyword: string | undefined;
  for (const [, , text] of keywordLines()) {
    const m = /^#\+CATEGORY:[ \t]*(\S.*?)[ \t]*$/i.exec(text);
    if (m) keyword = m[1];
  }
  return keyword ?? e8.fileNameNondirectory(file).replace(/\.[^.]*$/, "");
}

/** Shows what org-fold-reveal shows around point, then moves to the next heading shown if point is on a blank line, as org-archive-subtree ends. */
function revealAndSkipBlank(): void {
  // As org-fold-reveal: the entry, the next heading, the siblings and the headings above.
  showSetVisibility("lineage");
  // org-fold-reveal shows the siblings with org-goto-sibling, which steps a
  // character on from the heading it is under, found past a narrowing as
  // org-element-at-point finds it: at the end of what is shown, that fails,
  // as after archiving the last heading of a region the loop narrowed to.
  // At the end of the buffer itself there is no element, and nothing fails.
  const pt = e8.point();
  if (pt === e8.pointMax() && e8.saveRestriction(() => (e8.widen(), pt < e8.pointMax() && headingIndex(headings(), lineAt()) !== undefined)))
    e8.signal("end-of-buffer", "End of buffer");
  if (/^[ \t]*$/.test(e8.lineText(lineAt())) && e8.point() < e8.pointMax()) e8.call("outline-next-visible-heading");
}

/**
 * Moves the subtree at point to its archive location, as org-archive-subtree:
 * under the location's heading, or at the top level, in the location's
 * file, with ARCHIVE_ properties saying when and from where.
 */
export function archiveSubtree(): void {
  const thisBuffer = e8.currentBuffer();
  const now = today(true);
  const time = formatTimestamp(now, true);
  const fileName = e8.bufferFileName();
  if (fileName === undefined) e8.signal("error", "No file associated to buffer");
  const file = e8.abbreviateFileName(fileName!);
  // The entry and what is above it, widened, as Org's outline path and tags look past a narrowing.
  const [hereAll, hereI] = headingHere();
  const narrowedFrom = hereAll[hereI].start;
  const [all0, i0] = e8.saveRestriction(() => {
    e8.widen();
    const all = headings();
    return [all, all.findIndex((x) => x.start === narrowedFrom)] as [Heading[], number];
  });
  const h0 = all0[i0];
  const location = entryGetInherited(h0, "ARCHIVE", false) ?? keywordLocation() ?? String(e8.variable("org-archive-location") ?? "%s_archive::");
  const [afile, heading0] = computeLocation(location, fileName!);
  const infile = file === e8.abbreviateFileName(afile);
  const newFile = !e8.fileExists(afile);
  const buffer = infile ? thisBuffer : e8.findFileNoselect(afile);
  let heading: string | undefined = heading0;
  let datetree = false;
  let datetreeSub = false;
  // Levels step by two with org-odd-levels-only, as org-level-increment says.
  const odd = truthy(e8.variable("org-odd-levels-only") ?? null);
  const dt = /^datetree\/(\**)/.exec(heading);
  if (dt) {
    // A date tree is three levels, its day's at the fifth with odd levels only.
    datetreeSub = dt[1].length > 0;
    heading = "*".repeat((odd ? 5 : 3) + (odd ? 2 : 1) * dt[1].length) + heading.slice(dt[0].length);
    datetree = true;
  }
  let level = 0;
  const stars = /^\*+/.exec(heading ?? "");
  if (heading !== undefined && heading.length > 0 && stars) level = stars[0].length;
  else heading = undefined;
  // What it keeps of where it was, as org-archive-save-context-info names them.
  const tags = e8.saveRestriction(() => (e8.widen(), allTags(all0, i0)));
  const context: Record<string, string | undefined> = {
    category: categoryOf(h0, fileName!),
    file,
    itags: tags.inherited.join(" "),
    ltags: tags.local.join(" "),
    // Links as their descriptions, without COMMENT or statistics cookies, as org-get-outline-path gives them.
    olpath: ancestors(all0, i0)
      .reverse()
      .map((a) => all0[a].title.replace(/^COMMENT(?:[ \t]+|$)/, "").replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_m, l: string, d?: string) => d ?? l).replace(/\[[0-9]*(?:%|\/[0-9]*)\]/g, "").trim())
      .join("/"),
    time,
    todo: h0.todo,
  };
  // This buffer's TODO states, which marking the archived tree done uses in the archive too, as Org binds them there.
  const sourceKeywords = allKeywords();
  const sourceDone = sourceKeywords.filter((k) => isDone(k));
  const withSourceStates = withTheseTodoStates<void>();
  const origin = e8.makeMarker(h0.start);
  // Copied as it shows, within a narrowing, as Org copies it.
  e8.saveExcursion(() => {
    e8.gotoChar(h0.start);
    subtreeKill(false);
  });
  e8.withCurrentBuffer(buffer, () => {
    if (!e8.derivedModeP("org-mode")) {
      // An empty file gets a mode line, as org-mode does with org-insert-mode-line-in-empty-file.
      if (e8.bufferSize() === 0) e8.insert("#    -*- mode: org -*-\n\n");
      e8.call("org-mode");
    }
    e8.saveExcursion(() => {
      // Another file widened; this one as it shows, as Org searches and inserts within a narrowing, then widens.
      if (buffer !== thisBuffer) e8.widen();
      const header = e8.variable("org-archive-file-header-format");
      if (newFile && typeof header === "string") {
        e8.gotoChar(e8.pointMax());
        e8.insert(formatName(header, fileName!));
      }
      let narrowed: [number, number] | undefined;
      if (datetree) {
        // The day it was closed, else today, as org-datetree-find-date-create.
        const closed = /CLOSED: \[(\d{4})-(\d{2})-(\d{2})/.exec(e8.withCurrentBuffer(thisBuffer, () => e8.lineText(h0.line + 1)));
        const day = closed ? { year: Number(closed[1]), month: Number(closed[2]), day: Number(closed[3]) } : { year: now.year, month: now.month, day: now.day };
        // Widened, under a DATE_TREE heading if there is one, as org-datetree-find-date-create looks.
        e8.widen();
        const root = dateTreeRoot("day");
        const at = findDateCreate(day, "day", root.base, root.start, root.end, root.step);
        const there = headings();
        narrowed = subtreeRegion(there, there.findIndex((x) => x.start === at));
        // Without the newline before the next heading, as org-narrow-to-subtree.
        e8.narrowToRegion(narrowed[0], narrowed[1] === e8.pointMax() ? narrowed[1] : narrowed[1] - 1);
      }
      e8.gotoChar(e8.pointMin());
      const reversed = truthy(e8.variable("org-archive-reversed-order"));
      if (heading !== undefined && !(datetree && !datetreeSub)) {
        const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([ \\t]+:([\\p{L}\\p{N}_@#%]+:)+)?[ \\t]*$`, "mui");
        const text = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
        const m = re.exec(text);
        if (m) e8.gotoChar(e8.pointMin() + [...text.slice(0, m.index + m[0].length)].length);
        else {
          e8.gotoChar(e8.pointMax());
          if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
          e8.insert(`${datetree ? "" : "\n"}${heading}\n`);
          e8.gotoChar(e8.lineEnd(lineAt() - 1));
        }
        const there = headings();
        const hi = headingIndex(there, lineAt())!;
        e8.gotoChar(reversed ? (there[hi + 1]?.start ?? e8.pointMax()) : subtreeRegion(there, hi)[1]);
        // Back over blank lines, then two newlines (one in a date tree) before the tree, in one change, as replace-match makes it.
        let back = e8.point();
        while (back > e8.pointMin() && /[ \t\r\n]/.test(e8.bufferSubstringNoProperties(back - 1, back))) back--;
        e8.gotoChar(back);
        e8.lookingAt("[ \t\r\n]*");
        e8.gotoChar(e8.replaceMatch(datetree ? "\n" : "\n\n", { literal: true }).end);
      } else if (reversed) {
        e8.gotoChar(headings().find((x) => x.start >= e8.pointMin())?.start ?? e8.pointMax());
      } else {
        e8.gotoChar(e8.pointMax());
        if (!(datetree && e8.point() === e8.lineStart(lineAt()))) e8.insert("\n");
      }
      const pastedAt = e8.point();
      // A level below the heading, or the top, as org-get-valid-level gives it with the archive's org-odd-levels-only.
      pasteSubtree(validLevel(level, heading !== undefined ? 1 : undefined) as e8.PrefixArg);
      const pasted = headings().find((x) => x.start >= pastedAt);
      if (pasted) {
        e8.gotoChar(pasted.start);
        const addTags = e8.variable("org-archive-subtree-add-inherited-tags");
        if (tags.inherited.length > 0 && ((addTags === "infile" && infile) || addTags === true)) e8.call("org-set-tags", tags.tags.join(":"));
        // Done, as org-archive-mark-done says, without logging: its state if a done one, else the first done state.
        const markDone = e8.variable("org-archive-mark-done");
        // Read with this file's states, not the archive's, as Org binds them.
        const nowHeading = parseHeading(lineAt(pasted.start), sourceKeywords);
        if (truthy(markDone ?? null) && nowHeading && (nowHeading.todo === undefined || !sourceDone.includes(nowHeading.todo))) {
          const state = typeof markDone === "string" && sourceDone.includes(markDone) ? markDone : sourceDone[0];
          // As org-todo, with no state logged or done time, though a repeater still moves on.
          if (state !== undefined)
            withSourceStates(() =>
              e8.letBind({ "org-log-done": null }, () => {
                e8.gotoChar(pasted.start);
                e8.call("org-todo-set", state);
              }),
            );
        }
        const info = e8.variable("org-archive-save-context-info");
        for (const item of Array.isArray(info) ? info : []) {
          const value = context[String(item)];
          if (value !== undefined && /\S/.test(value)) {
            const line = lineAt(headings().find((x) => x.start >= pastedAt)?.start ?? pastedAt);
            entryPut(line, `ARCHIVE_${String(item).toUpperCase()}`, value);
          }
        }
      }
      if (buffer !== thisBuffer) {
        const save = e8.variable("org-archive-subtree-save-file-p");
        if (save === true || save === "from-org") e8.call("save-buffer");
      }
      e8.widen();
    });
  });
  e8.runHooks("org-archive-hook");
  // The original goes, as org-cut-subtree.
  e8.gotoChar(e8.markerPosition(origin) ?? h0.start);
  e8.deleteMarker(origin);
  subtreeKill(true);
  // Nothing more to move, as org-archive-subtree clears org-markers-to-move after its cut.
  clearMarkersToMove();
  // The statistics of the heading above point's count it gone, as org-up-heading-safe and org-update-statistics-cookies.
  if (truthy(e8.variable("org-provide-todo-statistics") ?? true)) {
    e8.saveExcursion(() => {
      const all = headings();
      const i = headingIndex(all, lineAt());
      const parent = i === undefined ? undefined : ancestors(all, i)[0];
      if (parent !== undefined) {
        e8.gotoChar(all[parent].start);
        e8.call("org-update-statistics-cookies");
      }
    });
  }
  e8.message(`Subtree archived ${buffer === thisBuffer ? `under heading: ${heading ?? ""}` : `in file: ${e8.abbreviateFileName(afile)}`}`);
  revealAndSkipBlank();
}

/**
 * Archives, or with tag tags ARCHIVE, the trees predicate picks, asking for
 * each, as org-archive-all-matches: the children of the heading point is
 * on, else every top-level tree. Predicate is called at a tree's heading
 * with where its subtree ends, and gives the reason to ask with, or
 * undefined to pass it by.
 */
function archiveAllMatches(predicate: (end: number) => string | undefined, tag: boolean): void {
  const archiveTag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const question = tag ? "Set ARCHIVE tag? " : "Move subtree to archive? ";
  const here = headings().find((h) => h.line === lineAt());
  let re: string;
  let begm, endm;
  if (here) {
    re = `^${"\\*".repeat(here.level + (truthy(e8.variable("org-odd-levels-only") ?? null) ? 2 : 1))} `;
    begm = marker(e8.point());
    // Point stays at the subtree's end, as org-end-of-subtree leaves it there.
    e8.gotoChar(treeEnd(here.start));
    endm = marker(e8.point());
  } else {
    re = "^\\* ";
    begm = marker(e8.pointMin());
    endm = marker(e8.pointMax());
  }
  let count = 0;
  try {
    e8.saveExcursion(() => {
      e8.gotoChar(begm.pos);
      while (e8.reSearchForward(re, { bound: endm.pos, noerror: true, caseFold: false }) !== undefined) {
        const beg = e8.matchBeginning()!;
        const end = treeEnd(beg);
        e8.gotoChar(beg);
        const reason = predicate(end);
        e8.gotoChar(beg);
        const tagged = tag && e8.lookingAt(`.*:${regexpQuote(archiveTag)}:`);
        if (reason !== undefined && !tagged && e8.yOrNP(`${question}(${reason})`)) {
          if (tag) {
            e8.gotoChar(beg);
            toggleArchiveTag();
            e8.gotoChar(beg);
          } else archiveSubtree();
          count++;
        } else e8.gotoChar(end);
      }
    });
  } finally {
    dropMarker(begm);
    dropMarker(endm);
  }
  e8.message(`${count} trees archived`);
}

/** Where the subtree whose heading starts at start ends, back over the blank lines before the next heading, as org-end-of-subtree. */
function treeEnd(start: number): number {
  const all = headings();
  let end = subtreeRegion(all, headingIndex(all, lineAt(start))!)[1];
  if (end > start && /[\n\r]/.test(e8.bufferSubstringNoProperties(end - 1, end))) {
    end--;
    while (end > e8.pointMin() && /[\n\r\t ]/.test(e8.bufferSubstringNoProperties(end - 1, end))) end--;
  }
  return end;
}

/** Archives the trees with no open TODO, as org-archive-all-done; with tag, tags them. */
function archiveAllDone(tag: boolean): void {
  // org-not-done-heading-regexp, matched in case.
  const re = `^\\(\\*+\\)\\(?: +${notDoneRegexp()}\\)\\(?: +\\(.*?\\)\\)?[ \t]*$`;
  archiveAllMatches((end) => (e8.reSearchForward(re, { bound: end, noerror: true, caseFold: false }) === undefined ? "no open TODO items" : undefined), tag);
}

/** The days from today to a timestamp's date, as org-timestamp-to-now. */
function daysToNow(ts: string): number {
  const m = /(\d+)-(\d+)-(\d+)/.exec(ts)!;
  const t = today();
  return (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(t.year, t.month - 1, t.day)) / 86400000;
}

/** Archives the trees whose first active timestamp is before today, a range ending before today too, as org-archive-all-old. */
function archiveAllOld(tag: boolean): void {
  // org-ts-regexp.
  const tsRe = "<\\([0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}\\(?: .*?\\)?\\)>";
  archiveAllMatches((end) => {
    if (e8.reSearchForward(tsRe, { bound: end, noerror: true }) === undefined) return undefined;
    const ts = e8.matchString(0)!;
    if (daysToNow(ts) >= 0) return undefined;
    if (!e8.lookingAt(`--\\(${tsRe}\\)`)) return `old timestamp ${ts}`;
    return daysToNow(e8.matchString(1)!) < 0 ? `old timestamp ${ts}${e8.matchString(0)!}` : undefined;
  }, tag);
}

/**
 * Runs body at every heading in the active region, as org-archive's
 * commands give org-map-entries when org-loop-over-headlines-in-active-region
 * is on, its value where to go on from. A C-u or C-u C-u, put in the form
 * Org builds as it is, is called as a function there, and C-- read as a
 * variable, as Org does. Returns whether it applied.
 */
function eachHeadingInRegion(body: () => number | void, prefix: e8.PrefixArg, scope?: (loop: e8.Value | undefined) => RegionScope): boolean {
  const fails = (): never =>
    Array.isArray(prefix)
      ? e8.signal("invalid-function", `Invalid function: ${prefix[0]}`, [prefix[0]])
      : e8.signal("void-variable", "Symbol’s value as variable is void: -", ["-"]);
  if ((Array.isArray(prefix) || prefix === "-") && forEachHeadingInRegion(fails, { hiddenPoint: true, hidden: true })) return true;
  // Each heading on its own, as Org binds the variable to nil around the loop.
  const once = () => e8.letBind({ "org-loop-over-headlines-in-active-region": null }, body) as number | void;
  return forEachHeadingInRegion(once, { hiddenPoint: true, hidden: true, narrow: true, scope });
}

/**
 * Goes back to the heading shown at or above point, as org-back-to-heading
 * without INVISIBLE-OK: where a hidden heading the loop reached is left
 * for one shown, within the region it narrowed to.
 */
function backToShownHeading(): number {
  const all = headings();
  for (let i = headingIndex(all, lineAt()); i !== undefined && i >= 0; i--) {
    if (all[i].start >= e8.pointMin() && !e8.invisibleAt(all[i].start)) {
      e8.gotoChar(all[i].start);
      return all[i].start;
    }
  }
  return e8.userError(`Before first headline at position ${e8.pointMin() + 1} in buffer ${e8.bufferName()}`);
}

/** org-archive-subtree with its prefix argument: C-u for the trees with no open TODO, C-u C-u for those dated before today. */
function archiveSubtreeWith(findDone: e8.PrefixArg): void {
  if (
    eachHeadingInRegion(() => {
      const from = backToShownHeading();
      archiveSubtreeWith(findDone);
      return from;
    }, findDone)
  )
    return;
  if (Array.isArray(findDone) && findDone[0] === 4) archiveAllDone(false);
  else if (Array.isArray(findDone) && findDone[0] === 16) archiveAllOld(false);
  else archiveSubtree();
}

const archiveSubtreeCommand = e8.defineCommand({
  name: "org-archive-subtree",
  doc:
    "Move the current subtree to the archive: org-archive-location's heading in this file or another, or the " +
    "location an ARCHIVE property or #+ARCHIVE: line gives, with properties saying when and from where it came. " +
    "With C-u, archive the trees with no open TODO, and with C-u C-u those with a timestamp before today, asking " +
    "for each: the children of the heading point is on, else every top-level tree. With the region active, " +
    "archive every heading in it (org-loop-over-headlines-in-active-region).",
  params: [{ name: "findDone", kind: "prefix" }],
  run: (findDone) => archiveSubtreeWith(findDone),
});

/** Folds the subtree point is in, its heading's line left showing, as org-fold-subtree. */
function foldSubtree(): void {
  const [all, i] = headingHere();
  // To the newline before the next heading, or the end of the buffer, as org-fold-subtree.
  const next = subtreeRegion(all, i)[1];
  const end = next >= e8.pointMax() ? e8.pointMax() : next - 1;
  if (end > e8.lineEnd(all[i].line)) flag(e8.lineEnd(all[i].line), end, true);
}

/** Where org-end-of-subtree goes without TO-HEADING: before the newline ending the subtree, back over blank lines. */
function endOfSubtree(all: Heading[], i: number): number {
  const end = subtreeRegion(all, i)[1];
  if (end <= e8.pointMin() || (e8.charBefore(end) !== "\n" && e8.charBefore(end) !== "\r")) return end;
  return e8.saveExcursion(() => {
    e8.gotoChar(end - 1);
    e8.skipCharsBackward("\n\r\t ");
    return e8.point();
  });
}

/** Toggles the ARCHIVE tag of the heading, as org-toggle-tag: whether it is on now. */
function toggleArchiveTag(): boolean {
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const [all, i] = headingHere();
  const h = all[i];
  const on = !h.tags.includes(tag);
  e8.saveExcursion(() => {
    e8.gotoChar(h.start);
    e8.call("org-set-tags", (on ? [...h.tags, tag] : h.tags.filter((t) => t !== tag)).join(":"));
  });
  return on;
}

/** org-toggle-archive-tag with its prefix argument: with one, tag the trees with no open TODO. */
function toggleArchiveTagWith(findDone: e8.PrefixArg): void {
  if (eachHeadingInRegion(() => toggleArchiveTagWith(findDone), findDone)) return;
  if (truthy(findDone)) {
    archiveAllDone(true);
    return;
  }
  let set = false;
  e8.saveExcursion(() => {
    set = toggleArchiveTag();
    if (set) foldSubtree();
  });
  if (set) e8.gotoChar(e8.lineStart(lineAt()));
  e8.message(`Subtree ${set ? "archived" : "unarchived"}`);
}

const toggleArchiveTagCommand = e8.defineCommand({
  name: "org-toggle-archive-tag",
  doc:
    "Toggle the archive tag for the current headline, folding its subtree when it is set. With a prefix argument, " +
    "offer to tag each child, or each top-level tree, with no open TODO. With the region active, toggle every heading in it.",
  params: [{ name: "findDone", kind: "prefix" }],
  run: (findDone) => toggleArchiveTagWith(findDone),
});

/** Sets the ARCHIVE tag, as org-archive-set-tag: on every heading of an active region. */
function setArchiveTag(): void {
  if (eachHeadingInRegion(setArchiveTag, null)) return;
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const [all, i] = headingHere();
  if (!all[i].tags.includes(tag)) toggleArchiveTag();
}

e8.defineCommand({
  name: "org-archive-set-tag",
  doc: "Set the ARCHIVE tag, on every heading of an active region.",
  run: () => setArchiveTag(),
});

const toSiblingCommand = e8.defineCommand({
  name: "org-archive-to-archive-sibling",
  doc:
    "Archive the current heading by moving it under the archive sibling, a sibling headed org-archive-sibling-heading with the ARCHIVE tag, " +
    "made at the end of the parent's subtree if there is none. With the region active, archive every heading in the buffer, " +
    "as Org does, or with org-loop-over-headlines-in-active-region start-level every heading in the region.",
  run: () => archiveToSiblingEach(),
});

/**
 * org-archive-to-archive-sibling over an active region: every heading the
 * loop reaches but archive siblings, which it goes past. Org gives
 * org-map-entries its scope as (when start-level 'region-start-level
 * 'region), so start-level loops over the whole region and any other value
 * over the whole buffer, or what is shown of it.
 */
function archiveToSiblingEach(): void {
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const once = () => {
    let from = backToShownHeading();
    const [all, i] = headingHere();
    // As Org looks at the line, case folded as case-fold-search says.
    if (e8.lookingAt(`^.*:${regexpQuote(tag)}:.*$`)) {
      e8.gotoChar(endOfSubtree(all, i));
      from = e8.point();
    }
    if (parseHeading(lineAt()) !== undefined) archiveToSibling();
    return from;
  };
  if (!eachHeadingInRegion(once, null, (loop) => (loop === "start-level" ? "region" : "buffer"))) archiveToSibling();
}

/** Moves the heading at point under its archive sibling, as org-archive-to-archive-sibling. */
function archiveToSibling(): void {
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const name = String(e8.variable("org-archive-sibling-heading") ?? "Archive");
  e8.saveRestriction(() => {
    e8.widen();
    const [all, i] = headingHere();
    const h = all[i];
    const leader = `${"*".repeat(h.level)} `;
    const pos = e8.makeMarker(h.start, { advances: true });
    // The parent's subtree, or the whole buffer at the top level.
    const up = ancestors(all, i)[0];
    const [b, e] = up === undefined ? [e8.pointMin(), e8.pointMax()] : subtreeRegion(all, up);
    const text = e8.bufferSubstringNoProperties(b, e);
    const re = new RegExp(`^${leader.replace(/\*/g, "\\*")}[ \\t]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:${tag}:`, "mi");
    const m = re.exec(text);
    let sibling: number;
    if (m) sibling = b + [...text.slice(0, m.index)].length;
    else {
      e8.gotoChar(e);
      if (e8.point() !== e8.lineStart(lineAt())) e8.call("newline");
      sibling = e8.point();
      e8.insert(`${leader}${name}\n`);
      e8.gotoChar(sibling);
      e8.call("org-set-tags", tag);
    }
    const there = headings();
    const si = there.findIndex((x) => x.start === sibling);
    const reversed = truthy(e8.variable("org-archive-reversed-order"));
    const target = e8.makeMarker(reversed ? (there[si + 1]?.start ?? e8.pointMax()) : subtreeRegion(there, si)[1]);
    e8.saveExcursion(() => {
      e8.gotoChar(e8.markerPosition(pos)!);
      subtreeKill(true);
    });
    e8.gotoChar(e8.markerPosition(target)!);
    e8.deleteMarker(target);
    const pastedAt = e8.point();
    pasteSubtree((h.level + 1) as e8.PrefixArg);
    const pasted = headings().find((x) => x.start >= pastedAt);
    if (pasted) entryPut(pasted.line, "ARCHIVE_TIME", formatTimestamp(today(true), true));
    // The sibling folded, as org-fold-subtree, its blank lines shown, and the counts above brought up to date.
    // The heading the tree went under, as outline-up-heading from it.
    const now = headings();
    const pi = now.findIndex((x) => x.start >= pastedAt);
    const above = pi < 0 ? undefined : ancestors(now, pi)[0];
    const sib = above === undefined ? undefined : now[above];
    if (sib) {
      e8.gotoChar(sib.start);
      foldSubtree();
      showEmptyLines("folded");
      if (truthy(e8.variable("org-provide-todo-statistics") ?? true)) updateParentTodoStatistics(sib.line);
    }
    e8.gotoChar(e8.markerPosition(pos) ?? e8.point());
    e8.deleteMarker(pos);
  });
  // No paste message, as org-paste-subtree called from code says nothing.
  e8.message("", { log: false });
  revealAndSkipBlank();
}

/** Archives with org-archive-default-command, as org-archive-subtree-default. */
function archiveDefault(): void {
  e8.callInteractively(String(e8.variable("org-archive-default-command") ?? "org-archive-subtree") as e8.CommandName);
}

const defaultCommand = e8.defineCommand({
  name: "org-archive-subtree-default",
  doc: "Archive the current subtree with the default command, org-archive-default-command.",
  run: () => archiveDefault(),
});

e8.defineCommand({
  name: "org-archive-subtree-default-with-confirmation",
  doc: "Archive the current subtree with the default command, asking first.",
  run: () => {
    if (e8.yOrNP("Archive this subtree or entry? ")) archiveDefault();
    else e8.signal("error", "Abort");
  },
});

// Org's keys, as org-keys.el binds them.
for (const [key, command] of [
  ["C-c C-x C-a", defaultCommand],
  ["C-c C-x C-s", archiveSubtreeCommand],
  ["C-c $", archiveSubtreeCommand],
  ["C-c C-x a", toggleArchiveTagCommand],
  ["C-c C-x A", toSiblingCommand],
] as const) e8.defineKey("org-mode-map", key, command);
