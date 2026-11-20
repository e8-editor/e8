// Refiling, after Org's org-refile.el: C-c C-w moves the subtree at point,
// or the subtrees of the active region, under a heading org-refile-targets
// names, in this file or another, chosen by its title or, with
// org-refile-use-outline-path, its outline path, a level at a time.

import { bookmarkSet, jumpTo } from "bookmark";
import { addLogNote, alignTags, copySubtree, type Heading, headings, killIsSubtree, parseHeading, pasteSubtree, subtreeRegion } from "org";
import { ancestors, showHeadingLine } from "org-fold";
import { entryHeading } from "org-list";
import { edDelete, lineAt, orgRegionActive } from "org-macs";
import { truthy } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar(
  "org-refile-targets",
  null,
  "Where C-c C-w can file a subtree, as a list of [files, kind, value]: files nil for this buffer, a file, a list of " +
    'them, or "org-agenda-files"; kind ":level" for headings of that level, ":maxlevel" for those up to it, ":tag" or ' +
    '":todo" for those with that tag or state, or ":regexp". Nil means this buffer\'s top-level headings.',
);
defvar("org-refile-use-outline-path", null, "Whether targets are named by their outline paths, Parent/Child, rather than their titles: t, or file, title, full-file-path or buffer-name to start the path with that.");
defvar("org-outline-path-complete-in-steps", true, "Whether outline paths complete a level at a time, as file names do, rather than whole.");
defvar(
  "org-log-refile",
  null,
  'Whether refiling is logged in the entry refiled: "time" for a note of when, "note" to ask for one too, nil for nothing. #+STARTUP: logrefile, lognoterefile or nologrefile says for a file.',
);
defvar("org-refile-history", null, "The targets chosen before, newest first.");
defvar("org-refile-target-verify-function", null, "A function called at each heading that may be a target, which says whether it is one.");
defvar("org-refile-use-cache", null, "Whether the targets are kept between refiles, until C-0 C-c C-w clears them.");
defvar(
  "org-refile-allow-creating-parent-nodes",
  null,
  'Whether a new heading can be made under a target by typing its path and "/new heading": t, confirm to ask first, or nil.',
);
defvar(
  "org-refile-active-region-within-subtree",
  null,
  "Whether an active region that is not whole subtrees can be refiled, its first line made a heading.",
);
defvar("org-refile-keep", null, "Whether refiling copies the subtree, leaving it where it was too.");
defvar(
  "org-reverse-note-order",
  null,
  "Whether refiled entries go in as the first child of their target rather than the last: t, or a list of [regexp, flag] lists by file name.",
);
defvar(
  "org-bookmark-names-plist",
  [":last-capture", "org-capture-last-stored", ":last-refile", "org-refile-last-stored", ":last-capture-marker", "org-capture-last-stored-marker"],
  "The names of the bookmarks Org sets where it last captured and refiled, as a plist; nil for none.",
);
e8.defineHook("org-after-refile-insert-hook", "Functions called where org-refile has put the subtree, before it goes from where it was.");

/** A place to refile to: its name, the file it is in, its heading's title to check it is still there, and its heading. */
export interface Target {
  name: string;
  file: string | undefined;
  buffer: string;
  title?: string;
  start: number | e8.Marker;
}

/** Where a target's heading is now. */
const startOf = (t: Target): number => (typeof t.start === "number" ? t.start : (e8.markerPosition(t.start) ?? -1));

/** A link written as its description, as org-link-display-format. */
const linkDisplay = (s: string): string => s.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, link: string, desc?: string) => desc ?? link);

/** A value of a plist variable, as plist-get. */
function plistGet(variable: string, key: string): e8.Value | undefined {
  const v = e8.variable(variable);
  if (!Array.isArray(v)) return undefined;
  for (let i = 0; i + 1 < v.length; i += 2) if (v[i] === key) return v[i + 1];
  return undefined;
}

/** Which headings a target spec takes, as org-refile-get-targets turns it into a regexp. */
function specMatcher(kind: string, value: e8.Value): (h: Heading, text: string) => boolean {
  switch (kind) {
    case ":level":
      return (h) => h.level === Number(value);
    case ":maxlevel":
      return (h) => h.level >= 1 && h.level <= Number(value);
    case ":tag":
      return (h) => h.tags.includes(String(value));
    case ":todo":
      return (h) => h.todo === String(value);
    case ":regexp":
      return (_h, text) => e8.stringMatch(String(value), text) !== undefined;
    default:
      return e8.signal("error", `Bad refiling target description ${kind}`);
  }
}

/** The files an entry names, as org-refile-get-targets reads them: buffers or file names. */
function entryFiles(files: e8.Value, defaultBuffer: string): string[] {
  if (files === null || files === undefined || files === false) return [defaultBuffer];
  if (files === "org-agenda-files") {
    const agenda = e8.variable("org-agenda-files");
    const dir = e8.variable("org-directory");
    return (Array.isArray(agenda) ? agenda : []).map((f) => e8.findFileNoselect(e8.expandFileName(String(f), typeof dir === "string" ? dir : undefined)));
  }
  const list = Array.isArray(files) ? files.map(String) : [String(files)];
  return list.map((f) => e8.findFileNoselect(e8.expandFileName(f)));
}

// The cache, as org-refile-cache: each file's targets by their spec, their headings as markers.

const cache = new Map<string, Target[]>();
let cacheMarkers: e8.Marker[] = [];

/** Forgets the targets kept, as org-refile-cache-clear. */
function cacheClear(): void {
  for (const m of cacheMarkers) e8.deleteMarker(m);
  cacheMarkers = [];
  cache.clear();
  e8.message("Refile cache has been cleared");
}

/** The targets kept for KEY, if caching and their buffers are all still there, as org-refile-cache-get. */
function cacheGet(key: string): Target[] | undefined {
  if (cache.size === 0) return undefined;
  if (!truthy(e8.variable("org-refile-use-cache"))) {
    cacheClear();
    return undefined;
  }
  const set = cache.get(key);
  if (set === undefined) return undefined;
  for (const t of set) {
    if (typeof t.start !== "number" && e8.markerBuffer(t.start) === undefined) {
      e8.message("Please regenerate the refile cache with ‘C-0 C-c C-w’");
      return undefined;
    }
  }
  return set;
}

/** Every place org-refile can file to, as org-refile-get-targets. */
export function refileTargets(defaultBuffer: string = e8.bufferName()): Target[] {
  const spec = e8.variable("org-refile-targets");
  const entries: [e8.Value, string, e8.Value][] = [];
  for (const e of Array.isArray(spec) && spec.length > 0 ? spec : [[null, ":level", 1]]) {
    if (!Array.isArray(e)) e8.signal("error", "Refile target must be a list: [files, kind, value]");
    // [files, kind, value], or [files, [kind, value]], as (FILES :kind . value) and (FILES :kind value).
    if (Array.isArray(e[1])) entries.push([e[0], String(e[1][0]), e[1][1]]);
    else entries.push([e[0], String(e[1]), e[2]]);
  }
  const outline = e8.variable("org-refile-use-outline-path");
  const verify = e8.variable("org-refile-target-verify-function");
  const caching = truthy(e8.variable("org-refile-use-cache"));
  e8.message("Getting targets...");
  const targets: Target[] = [];
  for (const [files, kind, value] of entries) {
    const matches = specMatcher(kind, value);
    for (const buffer of entryFiles(files, defaultBuffer)) {
      e8.withCurrentBuffer(buffer, () => {
        if (!e8.derivedModeP("org-mode")) e8.signal("error", `Major mode in refile target buffer "${buffer}" must be ‘org-mode’`);
        const file = e8.bufferFileName();
        // By the file and the spec only, as org-refile-cache-get's identifiers.
        const key = JSON.stringify([file ?? null, kind, value]);
        const kept = cacheGet(key);
        if (kept) {
          targets.push(...kept);
          return;
        }
        const found: Target[] = [];
        const fileName = file === undefined ? undefined : e8.fileNameNondirectory(file);
        const title = () => {
          const m = /^#\+title:[ \t]*(.*)$/im.exec(e8.bufferSubstringNoProperties(e8.pointMin(), Math.min(e8.pointMax(), e8.pointMin() + 4000)));
          return m?.[1] ?? fileName;
        };
        const head = outline === "file" ? fileName : outline === "title" ? title() : outline === "full-file-path" ? (file && e8.fileTruename(file)) : outline === "buffer-name" ? buffer : undefined;
        if (head !== undefined && outline !== null && outline !== true) found.push({ name: head, file, buffer, start: -1 });
        e8.saveRestriction(() => {
          e8.widen();
          const all = headings();
          const path: string[] = [];
          for (const h of all) {
            path.length = h.level - 1;
            // Without statistics cookies, as org--get-outline-path-1 takes them out.
            path[h.level - 1] = linkDisplay(h.title).replace(/\[[0-9]*(?:%|\/[0-9]*)\]/g, "").trim().replace(/\//g, "\\/");
            const text = e8.lineText(h.line);
            if (h.title === "" || !matches(h, text)) continue;
            if (verify !== null && verify !== undefined && !e8.saveExcursion(() => {
              e8.gotoChar(h.start);
              return e8.funcall(verify as string, []) !== null;
            })) continue;
            const ancestorPath = path.slice(0, h.level).filter((p) => p !== undefined);
            const name = outline === null || outline === false ? h.title : [...(head !== undefined ? [head] : []), ...ancestorPath].join("/");
            // A marker when caching, as org-refile-marker, so the heading is followed as the file changes.
            let start: number | e8.Marker = h.start;
            if (caching) {
              const m = e8.makeMarker(h.start);
              cacheMarkers.push(m);
              start = m;
            }
            found.push({ name, file, buffer, title: h.title, start });
          }
        });
        if (caching) cache.set(key, found);
        targets.push(...found);
      });
    }
  }
  e8.message("Getting targets...done");
  return targets;
}

/** The names the minibuffer offers, as org-refile-get-location decorates them: a / for a path, and other files' names. */
function decorated(targets: Target[]): [string, Target][] {
  const outline = e8.variable("org-refile-use-outline-path");
  const extra = outline === null || outline === false ? "" : "/";
  const base = e8.bufferBaseBuffer();
  const here = base ? e8.withCurrentBuffer(base, () => e8.bufferFileName()) : e8.bufferFileName();
  const truename = here === undefined ? undefined : e8.fileTruename(here);
  return targets.map((t) => {
    const other = !["file", "full-file-path", "title"].includes(String(outline)) && (t.file === undefined ? t.buffer !== e8.bufferName() : e8.fileTruename(t.file) !== truename);
    return [other ? `${t.name}${extra} (${t.file === undefined ? t.buffer : e8.fileNameNondirectory(t.file)})` : `${t.name}${extra}`, t];
  });
}

/** The target an answer names, with its slash or without, as org-refile--get-location: its name as it was found. */
function locationOf(answer: string, table: [string, Target][], targets: Target[]): [string, Target] | undefined {
  for (const name of [answer.replace(/\/$/, ""), answer.replace(/([^/])$/, "$1/")]) {
    const inTable = table.find(([n]) => n === name);
    if (inTable) return inTable;
    const t = targets.find((x) => x.name === name);
    if (t) return [t.name, t];
  }
  return undefined;
}

/**
 * The outline paths a level at a time, as org-olpath-completing-read reads
 * them: what is typed completes to the next level's paths, each ending in
 * its slash, with its file's name after it where it shows one.
 */
export function olpathTable(table: string[]): (input: string) => string[] {
  return (input) => {
    const out: string[] = [];
    for (const x of table) {
      if (!x.toLowerCase().startsWith(input.toLowerCase())) continue;
      const rest = x.slice(input.length);
      const file = / \([^)]*\)$/.exec(x)?.[0] ?? "";
      const slash = rest.indexOf("/");
      const shown = slash >= 0 ? input + rest.slice(0, slash + 1) + file : x;
      if (!out.includes(shown)) out.push(shown);
    }
    return out;
  };
}

/** Whether a target's heading is still the one it was, as org-refile-check-position. */
function checkPosition(t: Target): void {
  if (typeof t.start === "number" && t.file === undefined && t.buffer === undefined) e8.userError("Please indicate a target file in the refile path");
  if (t.title === undefined) return;
  const ok = e8.withCurrentBuffer(typeof t.start === "number" ? t.buffer : (e8.markerBuffer(t.start) ?? t.buffer), () =>
    e8.saveRestriction(() => {
      e8.widen();
      const at = startOf(t);
      if (at < 0) return false;
      return parseHeading(lineAt(at))?.title === t.title;
    }),
  );
  if (!ok) e8.userError("Invalid refile position, please clear the cache with ‘C-0 C-c C-w’ before refiling");
}

/** A new heading CHILD under PARENT's, as its last child, as org-refile-new-child: its target. */
function newChild(parent: Target, child: string): Target {
  return e8.withCurrentBuffer(parent.buffer, () =>
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        const pos = startOf(parent);
        let level: number | undefined;
        if (pos >= 0) e8.gotoChar(pos);
        else {
          e8.gotoChar(e8.pointMax());
          if (e8.point() !== e8.lineStart(lineAt())) e8.call("newline");
        }
        const all = headings();
        const i = all.findIndex((h) => h.start === e8.point());
        if (i >= 0) {
          level = all[i].level;
          e8.gotoChar(subtreeRegion(all, i)[1]);
        }
        // Back over blank lines, as org-back-over-empty-lines does when
        // org-blank-before-new-entry's heading entry is on; else to the line before's start.
        const before = e8.point();
        const blank = e8.variable("org-blank-before-new-entry");
        const heading = Array.isArray(blank) ? (blank.find((e) => Array.isArray(e) && e[0] === "heading") as e8.Value[] | undefined)?.[1] : "auto";
        if (truthy(heading ?? null)) {
          let at = before;
          while (at > e8.pointMin() && /[ \t\n\r]/.test(e8.bufferSubstringNoProperties(at - 1, at))) at--;
          e8.gotoChar(at);
        } else if (e8.point() < e8.pointMax()) e8.gotoChar(e8.lineStart(Math.max(0, lineAt() - 1)));
        e8.gotoChar(Math.min(e8.lineEnd(lineAt()) + 1, e8.pointMax()));
        if (e8.point() > before) e8.gotoChar(before);
        e8.insert(`\n${"*".repeat(pos >= 0 && level !== undefined ? level + 1 : 1)} ${child}\n`);
        e8.gotoChar(e8.lineStart(lineAt() - 1));
        return { name: `${parent.name}/${child}`, file: parent.file, buffer: parent.buffer, start: e8.point() };
      }),
    ),
  );
}

/** Asks where to refile to, as org-refile-get-location: the name chosen and its target, or none for a new node not made. */
export function getLocation(prompt: string, defaultBuffer?: string, newNodes: e8.Value = null, answer?: string): [string, Target] | undefined {
  const targets = refileTargets(defaultBuffer);
  if (targets.length === 0) e8.userError("No refile targets");
  const table = decorated(targets);
  const outline = truthy(e8.variable("org-refile-use-outline-path"));
  const steps = outline && truthy(e8.variable("org-outline-path-complete-in-steps"));
  const historyNow = (): string[] => {
    const h = e8.variable("org-refile-history");
    return Array.isArray(h) ? h.map(String) : [];
  };
  const oldHist = JSON.stringify(historyNow());
  const ownName = `${e8.bufferName()}${outline ? "/" : ""}`;
  const cdef = historyNow()[0] === undefined && table.some(([n]) => n === ownName) ? ownName : undefined;
  const dflt = historyNow()[0] ?? cdef;
  const names = table.map(([n]) => n);
  const chosen =
    answer ??
    e8.completingRead(dflt === undefined ? `${prompt}: ` : `${prompt} (default ${dflt}): `, steps ? olpathTable(names) : names, {
      requireMatch: !truthy(newNodes),
      history: "org-refile-history",
      default: cdef ?? historyNow()[0],
    });
  const found = locationOf(chosen, table, targets);
  if (found) {
    const hist = historyNow();
    const last = hist[0];
    checkPosition(found[1]);
    if (hist.length === 0 || JSON.stringify(hist) !== oldHist || found[0] !== last) {
      let next = [found[0], ...(table.some(([n]) => n === last) ? hist : hist.slice(1))];
      if (last === next[1]) next = next.slice(1);
      e8.setVariable("org-refile-history", next);
    }
    return found;
  }
  const m = /^(.*)\/([^/]+)$/s.exec(chosen);
  if (!m) e8.userError("Invalid target location");
  const parent = locationOf(m![1], table, targets);
  if (parent && (newNodes === true || (newNodes === "confirm" && e8.yOrNP(`Create new node "${m![2]}"? `)))) {
    const t = newChild(parent[1], m![2]);
    return [t.name, t];
  }
  return undefined;
}

/** Whether refiled entries go first under their target in the current file, as org-notes-order-reversed-p. */
function notesOrderReversed(): boolean {
  const v = e8.variable("org-reverse-note-order");
  if (v === true) return true;
  if (!Array.isArray(v)) return false;
  const file = e8.bufferFileName() ?? "";
  for (const entry of v) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && e8.stringMatch(entry[0], file) !== undefined) return truthy(entry[1] ?? null);
  }
  return false;
}

// The running clock, as org-clock-hd-marker: org-clock.ts, which loads after, says where it is.
let runningClock: () => { buffer: string; start: number; title: string } | undefined = () => undefined;
export function setRunningClock(f: typeof runningClock): void {
  runningClock = f;
}

/** Goes to where the last refile put its entry, as org-refile-goto-last-stored. */
export function gotoLastStored(): void {
  const name = plistGet("org-bookmark-names-plist", ":last-refile");
  jumpTo(typeof name === "string" ? name : "org-refile-last-stored", "switch-to-buffer");
  // As bookmark-after-jump-hook's org-bookmark-jump-unhide: the place shows if folded.
  if (e8.derivedModeP("org-mode")) showContext(e8.point());
  e8.message("This is the location of the last refile");
}

/** Shows the heading at POS and those above it, as org-fold-show-context does. */
function showContext(pos: number): void {
  const all = headings();
  const i = all.findIndex((h, j) => h.start <= pos && (all[j + 1] === undefined || all[j + 1].start > pos));
  if (i >= 0) for (const a of [i, ...ancestors(all, i)]) showHeadingLine(all[a]);
}

e8.defineCommand({
  name: "org-refile-goto-last-stored",
  doc: "Go to the location where the last refile was stored.",
  run: () => gotoLastStored(),
});

/** The heading point's entry starts at, or the error org-refile gives before the first. */
function subtreeHeading(): Heading {
  const h = entryHeading();
  if (!h) e8.userError(`Before first headline at position ${e8.lineStart(lineAt()) + 1} in buffer ${e8.bufferName()}`);
  return h;
}

/**
 * Moves the entry at point, or the region's entries, under another
 * heading, as org-refile: with C-u, goes there instead; C-u C-u, to where
 * the last refile put its entry; C-0 or C-u C-u C-u clears the targets
 * kept; 2, to the running clock's entry; 3, copying it.
 */
export function refile(arg: e8.PrefixArg | null, defaultBuffer?: string, rfloc?: [string, Target], msg?: string, answer?: string): void {
  const isList = Array.isArray(arg);
  const listN = isList ? (arg as number[])[0] : undefined;
  if (arg === 0 || listN === 64) return cacheClear();
  const actionmsg = msg ?? (arg === 3 ? "Refile (and keep)" : "Refile");
  // As org-region-active-p, use-region-p: an active region that is not empty.
  const regionp = orgRegionActive();
  let regionStart = regionp ? Math.min(e8.point(), e8.mark()!) : 0;
  let regionEnd = regionp ? Math.max(e8.point(), e8.mark()!) : 0;
  const keep = arg === 3 || truthy(e8.variable("org-refile-keep"));
  e8.setLastCommand(null);
  if (regionp) {
    e8.gotoChar(regionStart);
    regionStart = e8.lineStart(lineAt());
    e8.gotoChar(regionStart);
    if (!killIsSubtree(e8.bufferSubstringNoProperties(regionStart, regionEnd))) {
      // Its first line made a heading, as org-toggle-heading does, before
      // org-refile-active-region-within-subtree is asked, as Org's prog1 has it;
      // called as a function, so the region stays.
      const s = e8.lineEnd(lineAt());
      e8.letBind({ "deactivate-mark": false }, () => e8.call("org-toggle-heading"));
      regionEnd += e8.lineEnd(lineAt()) - s;
      if (!truthy(e8.variable("org-refile-active-region-within-subtree"))) e8.userError("The region is not a (sequence of) subtree(s)");
    }
  }
  if (listN === 16) return gotoLastStored();
  let it: [string, Target] | undefined;
  let goto = arg !== null && arg !== undefined && arg !== 3;
  const clock = arg === 2 ? runningClock() : undefined;
  if (clock) {
    it = [clock.title || "running clock", { name: clock.title || "running clock", file: e8.withCurrentBuffer(clock.buffer, () => e8.bufferFileName()), buffer: clock.buffer, start: clock.start }];
    goto = false;
  } else if (rfloc) it = rfloc;
  else {
    let headingText = "";
    // Each link as its description, or nothing, as org-refile replaces org-link-bracket-re with its second group.
    if (!isList) headingText = e8.saveExcursion(() => subtreeHeading().title).replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, _link: string, desc?: string) => desc ?? "");
    it = getLocation(
      isList ? "Goto" : regionp ? `${actionmsg} region to` : `${actionmsg} subtree "${headingText}" to`,
      defaultBuffer,
      listN === 4 ? null : (e8.variable("org-refile-allow-creating-parent-nodes") ?? null),
      answer,
    );
  }
  if (!it) return;
  const [name, t] = it;
  const pos = startOf(t);
  const same = t.buffer === e8.bufferName();
  if ((arg === null || arg === undefined) && pos >= 0 && same) {
    const inside = regionp
      ? pos >= regionStart && pos <= regionEnd
      : e8.saveExcursion(() => {
          const h = subtreeHeading();
          const all = headings();
          const [s, end] = subtreeRegion(all, all.findIndex((x) => x.start === h.start));
          return pos >= s && pos < end;
        });
    if (inside) e8.signal("error", "Cannot refile to position inside the tree or region");
  }
  if (goto) {
    if (t.buffer !== e8.bufferName()) e8.call("switch-to-buffer", t.buffer);
    e8.gotoChar(pos >= 0 ? pos : notesOrderReversed() ? e8.pointMin() : e8.pointMax());
    // The heading and those above it show, as org-fold-show-context does for org-goto.
    const all = headings();
    const i = all.findIndex((h) => h.start === pos);
    if (i >= 0) for (const a of [i, ...ancestors(all, i)]) showHeadingLine(all[a]);
    return;
  }
  // What goes: the region's text, or the subtree, copied; point stays, as org-copy-subtree leaves it.
  let start: number;
  let end: number;
  if (regionp) {
    start = regionStart;
    end = regionEnd;
    e8.killNew(e8.bufferSubstringNoProperties(start, end));
  } else {
    const here = e8.point();
    const h = subtreeHeading();
    const all = headings();
    [start, end] = subtreeRegion(all, all.findIndex((x) => x.start === h.start));
    e8.gotoChar(h.start);
    copySubtree(false, 1, false);
    e8.gotoChar(here);
  }
  // Back here after, whatever goes in before it, as Org's origin marker advancing.
  const origin = e8.makeMarker(e8.point(), { advances: true });
  e8.withCurrentBuffer(t.buffer, () => {
    const reversed = notesOrderReversed();
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        let level: number;
        const there = headings();
        const ti = pos >= 0 ? there.findIndex((x) => x.start === pos) : -1;
        if (pos >= 0 && ti >= 0) {
          level = Math.max(1, there[ti].level + 1);
          // First, before its first child; else after its subtree.
          e8.gotoChar(reversed ? (there[ti + 1]?.start ?? e8.pointMax()) : subtreeRegion(there, ti)[1]);
        } else {
          level = 1;
          if (!reversed) e8.gotoChar(e8.pointMax());
          // The first heading after the start, as outline-next-heading from point-min.
          else e8.gotoChar(there.find((h) => h.start > e8.pointMin())?.start ?? e8.pointMax());
        }
        if (e8.point() !== e8.lineStart(lineAt())) e8.call("newline");
        const pastedAt = e8.point();
        pasteSubtree(level as e8.PrefixArg);
        // Logged where it went, as org-log-refile says; a region's entries each with the time.
        const log = e8.variable("org-log-refile");
        if (truthy(log ?? null)) {
          if (regionp) {
            const pastedEnd = pastedAt + (end - start);
            for (const h of headings()) if (h.start >= pastedAt && h.start < pastedEnd) addLogNote(h.line, "refile", undefined, undefined, { how: "time" });
          } else addLogNote(lineAt(pastedAt), "refile", undefined, undefined, { how: log === "time" || log === "state" ? log : "note" });
        }
        // At the heading pasted, past any blank lines before it, as point is after org-paste-subtree.
        e8.gotoChar(headings().find((h) => h.start >= pastedAt)?.start ?? pastedAt);
        if (truthy(e8.variable("org-auto-align-tags") ?? true)) alignTags(lineAt());
        const bookmark = plistGet("org-bookmark-names-plist", ":last-refile");
        if (typeof bookmark === "string") {
          try {
            bookmarkSet(bookmark);
          } catch (err) {
            e8.message(`Bookmark set error: (error ${JSON.stringify(err instanceof Error ? err.message : String(err))})`);
          }
        }
        e8.deactivateMark();
        e8.runHooks("org-after-refile-insert-hook");
      }),
    );
  });
  e8.popKill();
  const back = e8.markerPosition(origin) ?? start;
  e8.deleteMarker(origin);
  e8.gotoChar(back);
  if (!keep) {
    if (regionp) edDelete(back, Math.min(back + (end - start), e8.pointMax()));
    else {
      // The subtree point is in, from its heading, as org-back-to-heading and org-end-of-subtree find it.
      const h = subtreeHeading();
      const all = headings();
      const [s, e] = subtreeRegion(all, all.findIndex((x) => x.start === h.start));
      edDelete(s, e);
      e8.gotoChar(s);
    }
  }
  const file = t.file ?? e8.withCurrentBuffer(t.buffer, () => e8.bufferFileName() ?? t.buffer);
  e8.message(`${actionmsg} to "${name}" in file ${file}: done`);
}

e8.defineCommand({
  name: "org--refile-to",
  doc: "File the subtree at point under the target given, as org-refile does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Refile subtree to: " }],
  run: (target) => refile(null, undefined, undefined, undefined, target),
});

e8.defineCommand({
  name: "org--refile-copy-to",
  doc: "Copy the subtree at point under the target given, as org-refile-copy does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Copy subtree to: " }],
  run: (target) => e8.letBind({ "org-refile-keep": true }, () => refile(null, undefined, undefined, "Copy", target)),
});

e8.defineCommand({
  name: "org--refile-goto",
  doc: "Go to the refile target given, as org-refile with C-u does.",
  params: [{ name: "target", kind: "string", prompt: "Goto: " }],
  run: (target) => refile([4] as unknown as e8.PrefixArg, undefined, undefined, undefined, target),
});

export const refileCommand = e8.defineCommand({
  name: "org-refile",
  doc:
    "Move the entry or entries at point to another heading, one org-refile-targets names, by default a top-level " +
    "heading of this buffer, as its last child (first with org-reverse-note-order). With an active region, its " +
    "subtrees move. With C-u, go to the heading instead; with C-u C-u, to where the last refile put its entry; with " +
    "C-0 or C-u C-u C-u, clear the targets kept (org-refile-use-cache); with 2, refile to the running clock; with 3, copy.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => refile(arg ?? null),
});

export const refileReverseCommand = e8.defineCommand({
  name: "org-refile-reverse",
  doc: "Refile while temporarily toggling org-reverse-note-order. So if org-refile would append the entry as the last entry under the target heading, org-refile-reverse will prepend it as the first entry, and vice-versa.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => e8.letBind({ "org-reverse-note-order": !notesOrderReversed() }, () => refile(arg ?? null)),
});

export const refileCopyCommand = e8.defineCommand({
  name: "org-refile-copy",
  doc: "Like org-refile, but preserve the refiled subtree.",
  run: () => e8.letBind({ "org-refile-keep": true }, () => refile(null, undefined, undefined, "Copy")),
});
