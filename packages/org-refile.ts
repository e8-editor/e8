// Refiling, after Org's org-refile.el: C-c C-w moves the subtree at point
// under a heading org-refile-targets names, in this file or another, chosen
// by its title or, with org-refile-use-outline-path, its outline path.

import { addLogNote, copySubtree, type Heading, headings, pasteSubtree, subtreeRegion } from "org";
import { ancestors, showHeadingLine } from "org-fold";
import { entryHeading } from "org-list";
import { edDelete, lineAt } from "org-macs";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar(
  "org-refile-targets",
  null,
  "Where C-c C-w can file a subtree, as a list of [files, kind, value]: files nil for this buffer, a file, a list of " +
    'them, or "org-agenda-files"; kind ":level" for headings of that level, ":maxlevel" for those up to it, ":tag" or ' +
    '":todo" for those with that tag or state, or ":regexp". Nil means this buffer\'s top-level headings.',
);
defvar("org-refile-use-outline-path", null, "Whether targets are named by their outline paths, Parent/Child, rather than their titles: t, or file, title, full-file-path or buffer-name to start the path with that.");
defvar("org-outline-path-complete-in-steps", true, "Whether outline paths complete a level at a time. E8 completes them whole.");
defvar(
  "org-log-refile",
  null,
  'Whether refiling is logged in the entry refiled: "time" for a note of when, "note" to ask for one too, nil for nothing. #+STARTUP: logrefile, lognoterefile or nologrefile says for a file.',
);
defvar("org-refile-history", null, "The targets chosen before, newest first.");
defvar("org-refile-target-verify-function", null, "A function called at each heading that may be a target, which says whether it is one.");
e8.defineHook("org-after-refile-insert-hook", "Functions called where org-refile has put the subtree, before it goes from where it was.");

/** A place to refile to: its name, the file it is in, and its heading. */
interface Target {
  name: string;
  file: string | undefined;
  buffer: string;
  start: number;
}

/** A link written as its description, as org-link-display-format. */
const linkDisplay = (s: string): string => s.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, link: string, desc?: string) => desc ?? link);

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
function entryFiles(files: e8.Value): string[] {
  if (files === null || files === undefined || files === false) return [e8.currentBuffer().name!];
  if (files === "org-agenda-files") {
    const agenda = e8.variable("org-agenda-files");
    const dir = e8.variable("org-directory");
    return (Array.isArray(agenda) ? agenda : []).map((f) => e8.findFileNoselect(e8.expandFileName(String(f), typeof dir === "string" ? dir : undefined)));
  }
  const list = Array.isArray(files) ? files.map(String) : [String(files)];
  return list.map((f) => e8.findFileNoselect(e8.expandFileName(f)));
}

/** Every place org-refile can file to, as org-refile-get-targets. */
export function refileTargets(): Target[] {
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
  e8.message("Getting targets...");
  const targets: Target[] = [];
  for (const [files, kind, value] of entries) {
    const matches = specMatcher(kind, value);
    for (const buffer of entryFiles(files)) {
      e8.withCurrentBuffer(buffer, () => {
        if (!e8.derivedModeP("org-mode")) e8.signal("error", `Major mode in refile target buffer "${buffer}" must be ‘org-mode’`);
        const file = e8.bufferFileName();
        const fileName = file === undefined ? undefined : e8.fileNameNondirectory(file);
        const title = () => {
          const m = /^#\+title:[ \t]*(.*)$/im.exec(e8.bufferSubstringNoProperties(e8.pointMin(), Math.min(e8.pointMax(), e8.pointMin() + 4000)));
          return m?.[1] ?? fileName;
        };
        const head = outline === "file" ? fileName : outline === "title" ? title() : outline === "full-file-path" ? (file && e8.fileTruename(file)) : outline === "buffer-name" ? buffer : undefined;
        if (head !== undefined && outline !== null && outline !== true) targets.push({ name: head, file, buffer, start: -1 });
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
            const ancestors = path.slice(0, h.level).filter((p) => p !== undefined);
            const name = outline === null || outline === false ? h.title : [...(head !== undefined ? [head] : []), ...ancestors].join("/");
            targets.push({ name, file, buffer, start: h.start });
          }
        });
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
  const here = e8.bufferFileName();
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

/** Asks where to refile to, as org-refile-get-location: the name chosen and its target. */
function getLocation(prompt: string, answer?: string): [string, Target] {
  const targets = refileTargets();
  if (targets.length === 0) e8.userError("No refile targets");
  const table = decorated(targets);
  const history = e8.variable("org-refile-history");
  const last = Array.isArray(history) && history.length > 0 ? String(history[0]) : undefined;
  const ownName = `${e8.bufferName()}${e8.variable("org-refile-use-outline-path") ? "/" : ""}`;
  const dflt = last ?? (table.some(([n]) => n === ownName) ? ownName : undefined);
  const chosen = answer ?? e8.completingRead(dflt === undefined ? `${prompt}: ` : `${prompt} (default ${dflt}): `, table.map(([n]) => n), {
    requireMatch: true,
    history: "org-refile-history",
    default: dflt,
  });
  const found = locationOf(chosen, table, targets);
  if (!found) e8.userError("Invalid target location");
  if (answer !== undefined || last !== found[0]) {
    const rest = Array.isArray(history) ? history.filter((h) => h !== found[0]) : [];
    e8.setVariable("org-refile-history", [found[0], ...rest]);
  }
  return found;
}

/** The subtree at point's heading, or the error org-refile gives before the first. */
function subtreeHeading(): Heading {
  const h = entryHeading();
  if (!h) e8.userError(`Before first headline at position ${e8.lineStart(lineAt()) + 1} in buffer ${e8.bufferName()}`);
  return h;
}

/**
 * Files the subtree at point under a target heading, as its last child, as
 * org-refile does: copied there with org-paste-subtree, in the target's
 * buffer, then deleted where it was, unless `keep`.
 */
function refile(answer: string | undefined, keep: boolean): void {
  const h = subtreeHeading();
  const action = keep ? "Copy" : "Refile";
  const [name, t] = getLocation(`${action} subtree "${linkDisplay(h.title)}" to`, answer);
  const all = headings();
  const i = all.findIndex((x) => x.start === h.start);
  const [start, end] = subtreeRegion(all, i);
  const same = t.buffer === e8.bufferName();
  if (same && t.start >= start && t.start < end) e8.signal("error", "Cannot refile to position inside the tree or region");
  const origin = e8.point();
  copySubtree(false, 1, false);
  const before = e8.bufferSize();
  let pastedAt = 0;
  e8.withCurrentBuffer(t.buffer, () => {
    e8.saveRestriction(() => {
      e8.widen();
      const there = headings();
      const ti = there.findIndex((x) => x.start === t.start);
      // After the target's subtree, at its next sibling or the end; with no heading, at the end at the top level.
      const at = ti < 0 ? e8.bufferSize() : subtreeRegion(there, ti)[1];
      const level = ti < 0 ? 1 : Math.max(1, there[ti].level + 1);
      e8.gotoChar(at);
      if (e8.point() !== e8.lineStart(lineAt())) e8.call("newline");
      pastedAt = e8.point();
      pasteSubtree(level as e8.PrefixArg);
      // Logged where it went, as org-log-refile says.
      const log = e8.variable("org-log-refile");
      if (log !== null && log !== undefined && log !== false) addLogNote(lineAt(pastedAt), "refile", undefined, undefined, { how: log === "time" || log === "state" ? log : "note" });
      e8.runHooks("org-after-refile-insert-hook");
    });
  });
  e8.popKill();
  // Back to the subtree where it was, after what was pasted before it.
  const moved = same && pastedAt <= start ? e8.bufferSize() - before : 0;
  e8.gotoChar(origin + moved);
  if (!keep) {
    edDelete(start + moved, end + moved);
    e8.gotoChar(start + moved);
  }
  const file = e8.withCurrentBuffer(t.buffer, () => e8.bufferFileName() ?? t.buffer);
  e8.message(`${action} to "${name}" in file ${file}: done`);
}

e8.defineCommand({
  name: "org--refile-to",
  doc: "File the subtree at point under the target given, as org-refile does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Refile subtree to: " }],
  run: (target) => refile(target, false),
});

e8.defineCommand({
  name: "org--refile-copy-to",
  doc: "Copy the subtree at point under the target given, as org-refile-copy does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Copy subtree to: " }],
  run: (target) => refile(target, true),
});

/** Goes to a target's heading, as org-refile with C-u does. */
function gotoTarget(answer?: string): void {
  const [, t] = getLocation("Goto", answer);
  if (t.buffer !== e8.bufferName()) e8.call("switch-to-buffer", t.buffer);
  e8.gotoChar(t.start < 0 ? e8.pointMax() : t.start);
  // The heading and those above it show, as org-fold-show-context does for org-goto.
  const all = headings();
  const i = all.findIndex((h) => h.start === t.start);
  if (i >= 0) for (const a of [i, ...ancestors(all, i)]) showHeadingLine(all[a]);
}

e8.defineCommand({
  name: "org--refile-goto",
  doc: "Go to the refile target given, as org-refile with C-u does.",
  params: [{ name: "target", kind: "string", prompt: "Goto: " }],
  run: (target) => gotoTarget(target),
});

export const refileCommand = e8.defineCommand({
  name: "org-refile",
  doc:
    "Move the subtree at point under another heading, asking which: one org-refile-targets names, by default " +
    "a top-level heading of this buffer. It goes in as that heading's last child. With C-u, go to the heading instead.",
  run: () => {
    if (Array.isArray(e8.prefixArg())) gotoTarget();
    else {
      subtreeHeading();
      refile(undefined, false);
    }
  },
});

export const refileCopyCommand = e8.defineCommand({
  name: "org-refile-copy",
  doc: "Copy the subtree at point under another heading, asking which, as org-refile does but keeping the original.",
  run: () => {
    subtreeHeading();
    refile(undefined, true);
  },
});
