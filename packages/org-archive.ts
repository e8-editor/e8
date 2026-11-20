// Archiving, after Org's org-archive.el: C-c C-x C-s (or C-c $) moves the
// subtree at point to its archive location, by default a file next to this
// one named FILE_archive, with properties saying where it came from;
// C-c C-x A moves it under an Archive sibling instead, and C-c C-x a
// toggles its ARCHIVE tag.

import {
  allKeywords,
  copySubtree,
  entryGetInherited,
  formatTimestamp,
  type Heading,
  headingIndex,
  headings,
  isDone,
  keywordLines,
  pasteSubtree,
  setTodo,
  subtreeRegion,
  today,
  updateParentTodoStatistics,
} from "org";
import { findDateCreate } from "org-datetree";
import { ancestors, flag, showHeadingLine } from "org-fold";
import { entryPut } from "org-list";
import { lineAt } from "org-macs";
import { truthy } from "subr";

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
  copySubtree(cut, 1, false);
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

/** Shows point's heading and those above it, then moves to the next heading shown if point is on a blank line, as org-archive-subtree ends. */
function revealAndSkipBlank(): void {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i !== undefined) for (const a of [i, ...ancestors(all, i)]) showHeadingLine(all[a]);
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
  const dt = /^datetree\/(\**)/.exec(heading);
  if (dt) {
    datetreeSub = dt[1].length > 0;
    heading = "*".repeat(3 + dt[1].length) + heading.slice(dt[0].length);
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
    // Links as their descriptions and without statistics cookies, as org-get-outline-path gives them.
    olpath: ancestors(all0, i0)
      .reverse()
      .map((a) => all0[a].title.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_m, l: string, d?: string) => d ?? l).replace(/\[[0-9]*(?:%|\/[0-9]*)\]/g, "").trim())
      .join("/"),
    time,
    todo: h0.todo,
  };
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
        const at = findDateCreate(day, "day", 1, e8.pointMin(), e8.pointMax());
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
        // Back over blank lines, then two newlines (one in a date tree) before the tree.
        let back = e8.point();
        while (back > e8.pointMin() && /[ \t\r\n]/.test(e8.bufferSubstringNoProperties(back - 1, back))) back--;
        let fwd = back;
        while (fwd < e8.pointMax() && /[ \t\r\n]/.test(e8.bufferSubstringNoProperties(fwd, fwd + 1))) fwd++;
        e8.deleteRegion(back, fwd);
        e8.gotoChar(back);
        e8.insert(datetree ? "\n" : "\n\n");
      } else if (reversed) {
        e8.gotoChar(headings().find((x) => x.start >= e8.pointMin())?.start ?? e8.pointMax());
      } else {
        e8.gotoChar(e8.pointMax());
        if (!(datetree && e8.point() === e8.lineStart(lineAt()))) e8.insert("\n");
      }
      const pastedAt = e8.point();
      pasteSubtree(Math.max(1, level + (heading !== undefined ? 1 : 0)) as e8.PrefixArg);
      const pasted = headings().find((x) => x.start >= pastedAt);
      if (pasted) {
        e8.gotoChar(pasted.start);
        const addTags = e8.variable("org-archive-subtree-add-inherited-tags");
        if (tags.inherited.length > 0 && ((addTags === "infile" && infile) || addTags === true)) e8.call("org-set-tags", tags.tags.join(":"));
        // Done, as org-archive-mark-done says, without logging: its state if a done one, else the first done state.
        const markDone = e8.variable("org-archive-mark-done");
        const nowHeading = headings().find((x) => x.start === pasted.start);
        if (truthy(markDone ?? null) && nowHeading && (nowHeading.todo === undefined || !isDone(nowHeading.todo))) {
          const done = allKeywords().filter((k) => isDone(k));
          const state = typeof markDone === "string" && done.includes(markDone) ? markDone : done[0];
          if (state !== undefined) setTodo(nowHeading, state);
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

const archiveSubtreeCommand = e8.defineCommand({
  name: "org-archive-subtree",
  doc:
    "Move the current subtree to the archive: org-archive-location's heading in this file or another, or the " +
    "location an ARCHIVE property or #+ARCHIVE: line gives, with properties saying when and from where it came.",
  run: () => archiveSubtree(),
});

/** Folds the subtree point is in, its heading's line left showing, as org-fold-subtree: to its end, the next heading's start. */
function foldSubtree(): void {
  const [all, i] = headingHere();
  const end = subtreeRegion(all, i)[1];
  if (end > e8.lineEnd(all[i].line)) flag(e8.lineEnd(all[i].line), end, true);
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

const toggleArchiveTagCommand = e8.defineCommand({
  name: "org-toggle-archive-tag",
  doc: "Toggle the archive tag for the current headline, folding its subtree when it is set.",
  run: () => {
    const set = toggleArchiveTag();
    if (set) {
      foldSubtree();
      e8.gotoChar(e8.lineStart(lineAt()));
    }
    e8.message(`Subtree ${set ? "archived" : "unarchived"}`);
  },
});

e8.defineCommand({
  name: "org-archive-set-tag",
  doc: "Set the ARCHIVE tag.",
  run: () => {
    const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
    const [all, i] = headingHere();
    if (!all[i].tags.includes(tag)) toggleArchiveTag();
  },
});

const toSiblingCommand = e8.defineCommand({
  name: "org-archive-to-archive-sibling",
  doc: "Archive the current heading by moving it under the archive sibling, a sibling headed org-archive-sibling-heading with the ARCHIVE tag, made at the end of the parent's subtree if there is none.",
  run: () => {
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
      // The sibling folded, as org-fold-subtree, and the counts above brought up to date.
      // The heading the tree went under, as outline-up-heading from it.
      const now = headings();
      const pi = now.findIndex((x) => x.start >= pastedAt);
      const above = pi < 0 ? undefined : ancestors(now, pi)[0];
      const sib = above === undefined ? undefined : now[above];
      if (sib) {
        e8.gotoChar(sib.start);
        foldSubtree();
        if (truthy(e8.variable("org-provide-todo-statistics") ?? true)) updateParentTodoStatistics(sib.line);
      }
      e8.gotoChar(e8.markerPosition(pos) ?? e8.point());
      e8.deleteMarker(pos);
    });
    // No paste message, as org-paste-subtree called from code says nothing.
    e8.message("", { log: false });
    revealAndSkipBlank();
  },
});

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
