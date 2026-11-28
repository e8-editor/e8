// The entry points of Org's export, preloaded, as org-loaddefs.el
// autoloads them: the dispatcher on C-c C-e and each backend's export
// commands, and the attachment dispatcher on C-c C-a. The exporter (ox.ts)
// and its backends, and org-attach.ts, load when one of these is first
// used; the command or function of the same name they define then takes the
// stub's place, and runs with the stub's arguments.

/** The parameters an export command takes, none of them asked for: async, subtree, visible only, body only and extra options. */
// Of kind "prefix", which code may leave out: a command call fills it with
// the call's prefix argument, nil without one, as Lisp's &optional is nil.
export const EXPORT_PARAMS: e8.Param[] = ["async", "subtreep", "visible-only", "body-only", "ext-plist"].map((name) => ({ name, kind: "prefix" as const }));

/** A publishing command's parameters: force, from the prefix argument, and async, which E8 ignores. */
const PUBLISH_PARAMS: e8.Param[] = [
  { name: "force", kind: "prefix" },
  { name: "async", kind: "prefix" },
];

/** org-publish's: the project's name, completed from org-publish-project-alist, then force and async. */
const PUBLISH_PROJECT_PARAMS: e8.Param[] = [
  {
    name: "project",
    prompt: "Publish project: ",
    collection: () => ((e8.variable("org-publish-project-alist") as e8.Value[][] | null) ?? []).map((p) => String(p[0])),
    requireMatch: true,
  },
  ...PUBLISH_PARAMS,
];

/** The stubs running, so one whose library does not replace it fails rather than calling itself. */
const running = new Set<string>();

const AUTOLOADS: [string, string, string, e8.Param[]][] = [
  ["org-export-dispatch", "ox", "Export dispatcher for Org mode.", [{ name: "arg", kind: "prefix" }]],
  ["org-export-insert-default-template", "ox", "Insert all export keywords with default values at beginning of line.", [{ name: "backend", value: () => "" }, { name: "subtreep", value: () => "" }]],
  ["org-ascii-export-as-ascii", "ox-ascii", "Export current buffer to a text buffer.", EXPORT_PARAMS],
  ["org-ascii-export-to-ascii", "ox-ascii", "Export current buffer to a text file.", EXPORT_PARAMS],
  ["org-ascii-convert-region-to-ascii", "ox-ascii", "Assume region has Org syntax, and convert it to plain ASCII.", []],
  ["org-ascii-convert-region-to-utf8", "ox-ascii", "Assume region has Org syntax, and convert it to UTF-8.", []],
  ["org-html-export-as-html", "ox-html", "Export current buffer to an HTML buffer.", EXPORT_PARAMS],
  ["org-html-export-to-html", "ox-html", "Export current buffer to an HTML file.", EXPORT_PARAMS],
  ["org-html-convert-region-to-html", "ox-html", "Assume the current region has Org syntax, and convert it to HTML.", []],
  ["org-html-htmlize-generate-css", "ox-html", "Create the CSS for all font definitions in the current Emacs session.", []],
  ["org-md-export-as-markdown", "ox-md", "Export current buffer to a Markdown buffer.", EXPORT_PARAMS],
  ["org-md-export-to-markdown", "ox-md", "Export current buffer to a Markdown file.", EXPORT_PARAMS],
  ["org-md-convert-region-to-md", "ox-md", "Assume the current region has Org syntax, and convert it to Markdown.", []],
  ["org-org-export-as-org", "ox-org", "Export current buffer to an Org buffer.", EXPORT_PARAMS],
  ["org-org-export-to-org", "ox-org", "Export current buffer to an Org file.", EXPORT_PARAMS],
  ...["org-publish", "org-publish-project"].map((name): [string, string, string, e8.Param[]] => [name, "ox-publish", "Publish PROJECT.", PUBLISH_PROJECT_PARAMS]),
  ["org-publish-all", "ox-publish", "Publish all projects.", PUBLISH_PARAMS],
  ["org-publish-current-file", "ox-publish", "Publish the current file.", PUBLISH_PARAMS],
  ["org-publish-current-project", "ox-publish", "Publish the project associated with the current file.", PUBLISH_PARAMS],
  ["org-icalendar-export-to-ics", "ox-icalendar", "Export current buffer to an iCalendar file.", EXPORT_PARAMS],
  ["org-icalendar-export-agenda-files", "ox-icalendar", "Export all agenda files to iCalendar files.", [{ name: "async", kind: "prefix" }]],
  ["org-icalendar-combine-agenda-files", "ox-icalendar", "Combine all agenda files into a single iCalendar file.", [{ name: "async", kind: "prefix" }]],
  // Org Crypt's commands, which load org-crypt.ts and EasyPG's epg.ts.
  ["org-encrypt-entry", "org-crypt", "Encrypt the content of the current headline.", []],
  ["org-encrypt-entries", "org-crypt", "Encrypt all top-level entries in the current buffer.", []],
  ["org-decrypt-entry", "org-crypt", "Decrypt the content of the current headline.", []],
  ["org-decrypt-entries", "org-crypt", "Decrypt all entries in the current buffer.", []],
  // Org Cite's command, which loads oc.ts.
  ["org-cite-insert", "oc", "Insert a citation at point, as org-cite-insert-processor does; with a prefix argument, its style too.", [{ name: "arg", kind: "prefix" }]],
  ["org-attach", "org-attach", "The dispatcher for attachment commands.", []],
  ["org-attach-dired-to-subtree", "org-attach", "Attach the files marked in Dired to the subtree in the other window.", []],
];

/** The functions projects name to publish their files, and org-attach-dir, loading the library that defines each when it is first called. */
const PUBLISHING_FUNCTIONS: [string, string][] = [
  ["org-html-publish-to-html", "ox-html"],
  ["org-ascii-publish-to-ascii", "ox-ascii"],
  ["org-ascii-publish-to-latin1", "ox-ascii"],
  ["org-ascii-publish-to-utf8", "ox-ascii"],
  ["org-md-publish-to-md", "ox-md"],
  ["org-org-publish-to-org", "ox-org"],
  ["org-publish-attachment", "ox-publish"],
  // Not a publishing function, but autoloaded the same way, as a config calls it.
  ["org-crypt-use-before-save-magic", "org-crypt"],
  ["org-attach-dir", "org-attach"],
];

for (const [name, feature] of PUBLISHING_FUNCTIONS)
  e8.defun(name, (...args: any[]) => {
    if (running.has(name)) e8.userError(`Autoloading ${feature} did not define ${name}`);
    running.add(name);
    try {
      e8.require(feature);
      return e8.funcall(name, ...args);
    } finally {
      running.delete(name);
    }
  });

for (const [name, feature, doc, params] of AUTOLOADS) {
  e8.defineCommand({
    name,
    doc,
    params,
    run: (...args: any[]) => {
      if (running.has(name)) e8.userError(`Autoloading ${feature} did not define ${name}`);
      running.add(name);
      try {
        e8.require(feature);
        return e8.call(name as any, ...args);
      } finally {
        running.delete(name);
      }
    },
  });
}

e8.defineKey("org-mode-map", "C-c C-e", "org-export-dispatch" as any);
e8.defineKey("org-mode-map", "C-c C-x @", "org-cite-insert" as any);

// Citations, which Org activates and follows through oc.el. oc.ts loads
// only for text that may hold one: "[cite" within a few lines.

/** Whether the text from a few lines before START to END may hold a citation. */
function mayHoldCitation(start: number, end: number): boolean {
  const from = e8.lineStart(Math.max(0, e8.lineOf(start) - 3));
  const to = e8.lineEnd(e8.lineOf(Math.min(Math.max(end - 1, start), e8.pointMax())));
  return e8.bufferText(from, Math.max(from, to)).includes("[cite");
}

/** Activates the citations jit-lock fontifies, as Org's font-lock calls org-cite-activate. */
function activateCitations(start: number, end: number): void {
  if (!e8.derivedModeP("org-mode") || !mayHoldCitation(start, end)) return;
  e8.require("oc");
  e8.funcall("org-cite-activate", start, end);
}

e8.addHook("org-mode-hook", () => e8.addHook("jit-lock-functions", activateCitations, { local: true, append: true }));

// Called by org-open-at-point off a link: follows the citation at point, if there is one, and says whether there was.
e8.defun("org-cite--follow-at-point", (arg?: e8.PrefixArg) => {
  if (!mayHoldCitation(e8.point(), e8.point() + 1)) return false;
  e8.require("oc");
  return e8.funcall("org-cite--follow-at-point", arg ?? null);
});
e8.defineKey("org-mode-map", "C-c C-a", "org-attach" as any);

e8.defineVariable({
  name: "org-export-backends",
  value: [e8.intern("ascii"), e8.intern("html"), e8.intern("icalendar"), e8.intern("md")],
  doc: "The export backends the dispatcher offers, loaded with it: ascii, html, icalendar and md.",
});
