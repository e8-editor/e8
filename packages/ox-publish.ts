// Publishing related Org files as a website, after Org 9.7's
// ox-publish.el: each project of org-publish-project-alist names a
// directory of source files, where they are published and how, with a
// sitemap, a concept index and links between its files resolved; files
// unchanged since they were last published are skipped, by timestamps
// kept in org-publish-timestamp-directory.
//
// A project is written as Org's, a list of its name and then keys and
// values: ["site", ":base-directory", "~/org", ":publishing-directory",
// "~/public_html", ":recursive", true]. Keys may be strings or symbols
// (e8.intern(":recursive")), and so may symbols among the values ("any",
// "tree", "list"). A function a project names, as its
// :publishing-function, is a function or the name of one.
//
// Unlike Org, the cache of each project is JSON, PROJECT.e8.json, as E8
// reads no Lisp (ADR 0116), so E8's caches and Emacs's live side by side
// in the same directory.

import { type Datum, type Node, lineage, map } from "org-element-ast";
import { interpretData, parseBuffer } from "org-element";
import { type Info, brokenLink, flag, formatReference, getEnvironment, newReference, nonNil, outputFileName, stringToSearchCell, toFile, varValue, withBufferCopy } from "ox";
import { listToOrg } from "ox-org";
import { entryGet } from "org-list";
import { searchInBuffer } from "ol";
import { fileRelativeName as relativeName, findBufferVisiting } from "files";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });

defvar("org-publish-project-alist", [], "Projects to publish: each a list of the project's name, then its properties as keys and values, as Org's, or :components naming other projects.");
defvar("org-publish-use-timestamps-flag", true, "Non-nil means use timestamp checking to publish only changed files.");
defvar("org-publish-timestamp-directory", "~/.org-timestamps/", "Name of directory in which to store publishing timestamps.");
defvar("org-publish-list-skipped-files", true, "Non-nil means show message about files *not* published.");
defvar("org-publish-sitemap-sort-files", "alphabetically", "How to sort files in site-maps: alphabetically, chronologically, anti-chronologically or nil.");
defvar("org-publish-sitemap-sort-folders", "ignore", "Where folders go in site-maps: first, last, ignore (left out), or nil to mix them with files.");
defvar("org-publish-sitemap-sort-ignore-case", false, "Non-nil when site-map sorting should ignore case.");
defvar("org-publish-after-publishing-hook", [], "Functions called each time a file is published, with the source file's name and the published file's.");
defvar("org-file-buffer-created", null, "While org-with-file-buffer runs, the file it visited for it, when it made the buffer.");

/** A project: its name, then keys and values. */
export type Project = e8.Value[];

const sym = (v: unknown): any => (typeof v === "symbol" ? e8.symbolName(v) : v);
const isNil = (v: unknown) => v === undefined || v === null || v === false;
const keyName = (k: unknown) => String(sym(k));
const err = (message: string): never => e8.signal("error", message);
/** Prints a string as Lisp's %S does. */
const S = (s: unknown) => (typeof s === "string" ? JSON.stringify(s) : String(sym(s)));

/** Whether a property list has KEY, as plist-member. */
function plistMember(plist: e8.Value[], key: string): boolean {
  for (let i = 0; i + 1 < plist.length; i += 2) if (keyName(plist[i]) === key) return true;
  return false;
}

/** A property list's value for KEY, as plist-get, with symbols as their names. */
export function plistGet(plist: e8.Value[] | undefined, key: string): any {
  if (!Array.isArray(plist)) return undefined;
  for (let i = 0; i + 1 < plist.length; i += 2) if (keyName(plist[i]) === key) return sym(plist[i + 1]);
  return undefined;
}

/** A project's PROPERTY, or DEFAULT when it does not set it, as org-publish-property. */
export function property(prop: string, project: Project, dflt?: any): any {
  const plist = project.slice(1);
  return plistMember(plist, prop) ? plistGet(plist, prop) : dflt;
}

/** A project's properties as export options: :with-toc as with-toc, symbols as their names. */
function optionsOf(plist: e8.Value[]): Info {
  const info: Info = {};
  // The first of a key's values counts, as plist-get finds it.
  for (let i = 0; i + 1 < plist.length; i += 2) {
    const key = keyName(plist[i]).replace(/^:/, "");
    if (!(key in info)) info[key] = sym(plist[i + 1]);
  }
  return info;
}

const isDirName = (f: string) => f.endsWith("/");

/** A file's name relative to a directory, keeping a directory's slash, as file-relative-name. */
function rel(file: string, dir: string): string {
  const r = relativeName(file, dir);
  return isDirName(file) && r !== "." ? r + "/" : r;
}

const extension = (f: string) => /\.([^./]*)$/.exec(e8.fileNameNondirectory(f))?.[1];
const sansExtension = (f: string) => f.replace(/\.[^./]*$/, "");
const fileEqualP = (a: string, b: string) => e8.fileTruename(e8.expandFileName(a)) === e8.fileTruename(e8.expandFileName(b));
const uniquify = <T>(xs: T[]) => [...new Set(xs)];

function asFunctionList(v: any): any[] {
  if (isNil(v)) return [];
  return Array.isArray(v) ? v.map(sym) : [sym(v)];
}

/** Call a function or a function's name. */
function call(f: any, ...args: any[]): any {
  return e8.funcall(f, ...args);
}

/** A file's text written to it, as with-temp-file. */
function writeFile(file: string, text: string): void {
  const buffer = e8.generateNewBufferName(" *temp file*");
  e8.getBufferCreate(buffer);
  try {
    e8.withCurrentBuffer(buffer, () => {
      e8.insert(text);
      e8.writeRegion(null, null, file, { quiet: true });
    });
  } finally {
    e8.call("kill-buffer", buffer);
  }
}

function readFile(file: string): string {
  const buffer = e8.generateNewBufferName(" *temp file*");
  e8.getBufferCreate(buffer);
  try {
    return e8.withCurrentBuffer(buffer, () => {
      e8.insertFileContents(file);
      return e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    });
  } finally {
    e8.call("kill-buffer", buffer);
  }
}

/**
 * Run BODY in a buffer visiting FILE, made for it and killed after when no
 * buffer visits it already, as org-with-file-buffer; org-file-buffer-created
 * is the file then.
 */
export function withFileBuffer<T>(file: string, body: () => T): T {
  const existing = findBufferVisiting(file);
  const buffer = existing ?? e8.findFileNoselect(file);
  try {
    return e8.withCurrentBuffer(buffer, () => e8.letBind({ "org-file-buffer-created": existing ? null : file }, body));
  } finally {
    if (!existing && e8.getBuffer(buffer)) e8.call("kill-buffer", buffer);
  }
}

// --- Timestamps ------------------------------------------------------------------

/** The cache's key for a file published to PUB-DIR by PUB-FUNC, as org-publish-timestamp-filename. */
function timestampFilename(filename: string, pubDir?: string, pubFunc?: any): string {
  const f = typeof pubFunc === "function" ? pubFunc.name || "lambda" : (pubFunc ?? "");
  return "X" + e8.secureHash("sha1", `${filename}::${pubDir ?? ""}::${f}`);
}

const funcName = (f: any) => (typeof f === "function" ? f.name || "lambda" : String(f));

/** Whether FILENAME is to be published, as org-publish-needed-p; says which. */
function neededP(filename: string, pubDir?: string, pubFunc?: any, _truePubDir?: string, baseDir?: string): boolean {
  const rtn = !nonNil(varValue("org-publish-use-timestamps-flag")) || cacheFileNeedsPublishing(filename, pubDir, pubFunc, baseDir);
  if (rtn) e8.message(`Publishing file ${filename} using \`${funcName(pubFunc)}'`);
  else if (nonNil(varValue("org-publish-list-skipped-files"))) e8.message(`Skipping unmodified file ${filename}`);
  return rtn;
}

function updateTimestamp(filename: string, pubDir?: string, pubFunc?: any): void {
  cacheSet(timestampFilename(filename, pubDir, pubFunc), mtimeOfSrc(filename));
}

/** Delete every file in the timestamp directory, as org-publish-remove-all-timestamps. */
export function removeAllTimestamps(): void {
  const dir = String(varValue("org-publish-timestamp-directory"));
  if (e8.fileExistsP(dir) && e8.fileDirectoryP(dir)) {
    for (const f of e8.directoryFiles(dir, { full: true })) if (!f.endsWith(".") && !e8.fileDirectoryP(f)) e8.deleteFile(f);
    resetCache();
  }
}

// --- Projects --------------------------------------------------------------------

const projects = (): Project[] => (varValue("org-publish-project-alist") as Project[] | null) ?? [];
const assoc = (name: unknown) => projects().find((p) => p[0] === name);

/** FILE expanded in the project's base directory, as org-publish--expand-file-name. */
function expandIn(file: string, project: Project): string {
  return e8.fileNameAbsoluteP(file) ? file : e8.expandFileName(file, property(":base-directory", project));
}

/** The projects with each meta-project's components in its place, as org-publish-expand-projects. */
export function expandProjects(alist: Project[]): Project[] {
  const rest = [...alist];
  const out: Project[] = [];
  let p: Project | undefined;
  while ((p = rest.shift())) {
    const components = plistGet(p.slice(1), ":components");
    if (!isNil(components)) {
      const list = (Array.isArray(components) ? components : [components]).map(sym);
      rest.unshift(...list.map((x: unknown) => assoc(x) ?? e8.userError(`Unknown component ${S(x)} in project ${S(p![0])}`)));
    } else out.push(p);
  }
  return uniquify(out);
}

/** Every file of a project, as org-publish-get-base-files. */
export function getBaseFiles(project: Project): string[] {
  const baseDir = e8.fileNameAsDirectory(e8.expandFileName(property(":base-directory", project)));
  const ext = property(":base-extension", project) ?? "org";
  const match = ext === "any" ? "" : `^[^\\.].*\\.\\(${ext}\\)$`;
  const matches = (name: string) => e8.stringMatch(match, name) !== undefined;
  let baseFiles: string[] = [];
  if (!e8.fileExistsP(baseDir)) baseFiles = [];
  else if (isNil(property(":recursive", project)))
    baseFiles = e8
      .directoryFiles(baseDir)
      .filter(matches)
      .map((f) => baseDir + f)
      .filter((f) => !e8.fileDirectoryP(f));
  else {
    const files: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 100) err(`Apparent cycle of symbolic links for ${S(baseDir)}`);
      for (const f of e8.fileNameAllCompletions("", dir).sort()) {
        if (f === "./" || f === "../") continue;
        if (isDirName(f)) walk(e8.expandFileName(f, dir), depth + 1);
        else if (matches(f)) files.push(e8.expandFileName(f, dir));
      }
    };
    walk(baseDir, 0);
    baseFiles = files;
  }
  const exclude = property(":exclude", project);
  if (!isNil(exclude)) baseFiles = baseFiles.filter((f) => e8.stringMatch(String(exclude), relativeName(f, baseDir)) === undefined);
  const sitemap = nonNil(property(":auto-sitemap", project)) ? [e8.expandFileName(property(":sitemap-filename", project) ?? "sitemap.org", baseDir)] : [];
  const include = (property(":include", project) ?? []) as string[];
  return uniquify([...baseFiles, ...sitemap, ...include.map((f) => e8.expandFileName(f, baseDir))]);
}

/** The project a file belongs to, or with UP the outermost meta-project publishing it, as org-publish-get-project-from-filename. */
export function getProjectFromFilename(filename: string, up = false): Project | undefined {
  const file = e8.expandFileName(filename);
  const project = projects().find((p) => {
    if (!isNil(property(":components", p))) return false;
    const base = e8.expandFileName(property(":base-directory", p));
    const include = (property(":include", p) ?? []) as string[];
    if (include.map((f) => e8.expandFileName(f, base)).some((f) => fileEqualP(f, file))) return true;
    const exclude = property(":exclude", p);
    if (!isNil(exclude) && e8.stringMatch(String(exclude), relativeName(file, base)) !== undefined) return false;
    const ext = property(":base-extension", p);
    if (!(ext === "any" || (ext ?? "org") === extension(file))) return false;
    return getBaseFiles(p).includes(file);
  });
  if (!project || !up) return project;
  // The meta-project whose components include it, and the one above that.
  const findParent = (p: Project): Project => {
    for (const q of projects()) if ((asFunctionList(property(":components", q)) as unknown[]).includes(p[0])) return findParent(q);
    return p;
  };
  return findParent(project);
}

// --- Publishing functions for backends -------------------------------------------

/**
 * Publish an Org file with BACKEND to a file with EXTENSION in PUB-DIR, as
 * org-publish-org-to; returns the file written. The project's properties
 * are the export's options, and the cross-references and index the
 * export finds are kept in the cache.
 */
export function publishOrgTo(backend: string, filename: string, ext: string, plist: e8.Value[], pubDir?: string): string {
  if (pubDir && !e8.fileExistsP(pubDir)) e8.makeDirectory(pubDir, { parents: true });
  return e8.letBind({ "org-inhibit-startup": true }, () =>
    withFileBuffer(filename, () => {
      const output = outputFileName(ext, false, pubDir);
      const options = optionsOf(plist);
      return toFile(backend, output, false, false, nonNil(options["body-only"]), {
        ...options,
        crossrefs: cacheGetFileProperty(e8.fileTruename(filename), ":crossrefs", undefined, true),
        "filter-final-output": [storeCrossrefs, collectIndex, ...asFunctionList(options["filter-final-output"])],
      });
    }),
  );
}

/** Publish a file as it is, copied to PUB-DIR, as org-publish-attachment; returns the copy's name. */
export function publishAttachment(_plist: e8.Value[], filename: string, pubDir: string): string {
  if (!e8.fileDirectoryP(pubDir)) e8.makeDirectory(pubDir, { parents: true });
  const output = e8.expandFileName(e8.fileNameNondirectory(filename), pubDir);
  if (!fileEqualP(e8.fileNameDirectory(e8.expandFileName(filename)) ?? "/", e8.fileNameAsDirectory(e8.expandFileName(pubDir)))) e8.copyFile(filename, output, { okIfExists: true });
  return output;
}

// --- Publishing files and projects -----------------------------------------------

/** Publish FILENAME of PROJECT, or the project it belongs to, as org-publish-file. */
export function publishFile(filename: string, project?: Project, noCache = false): void {
  const p = project ?? getProjectFromFilename(filename) ?? e8.userError(`File ${S(e8.abbreviateFileName(filename))} is not part of any known project`);
  const plist = p.slice(1);
  const fn = property(":publishing-function", p, "org-html-publish-to-html");
  if (isNil(fn)) e8.userError("No publishing function chosen");
  const functions = asFunctionList(fn);
  const base = property(":base-directory", p);
  if (isNil(base)) e8.userError(`Project ${S(p[0])} does not have :base-directory defined`);
  const baseDir = e8.fileNameAsDirectory(base);
  const pubBase = property(":publishing-directory", p);
  if (isNil(pubBase)) e8.userError(`Project ${S(p[0])} does not have :publishing-directory defined`);
  const pubBaseDir = e8.fileNameAsDirectory(pubBase);
  const pubDir = e8.fileNameDirectory(e8.expandFileName(relativeName(filename, baseDir), pubBaseDir)) ?? pubBaseDir;
  if (!noCache) initializeCache(String(p[0]));
  for (const f of functions) {
    if (neededP(filename, pubBaseDir, f, pubDir, baseDir)) {
      const output = call(f, plist, filename, pubDir);
      updateTimestamp(filename, pubBaseDir, f);
      e8.runHooks("org-publish-after-publishing-hook", filename, output);
    }
  }
  writeCacheFile();
}

function callAll(fun: any, plist: e8.Value[]): void {
  for (const f of asFunctionList(fun)) call(f, plist);
}

/** Publish every file of PROJECTS, their sitemaps and indexes, as org-publish-projects. */
export function publishProjects(list: Project[]): void {
  for (const project of expandProjects(list)) {
    const plist = project.slice(1);
    callAll(property(":preparation-function", project), plist);
    initializeCache(String(project[0]));
    if (nonNil(property(":auto-sitemap", project))) sitemap(project, property(":sitemap-filename", project) ?? "sitemap.org");
    const theindex = e8.expandFileName("theindex.org", property(":base-directory", project));
    for (const file of getBaseFiles(project)) if (!fileEqualP(file, theindex)) publishFile(file, project, true);
    if (nonNil(property(":makeindex", project))) {
      indexGenerateTheindex(project, property(":base-directory", project));
      publishFile(theindex, project, true);
    }
    callAll(property(":completion-function", project), plist);
    writeCacheFile();
  }
}

// --- Site maps -------------------------------------------------------------------

/** FILES as a plain list in Lisp form, an entry for each, as org-publish--sitemap-files-to-lisp. */
function sitemapFilesToLisp(files: string[], project: Project, style: string, formatEntry: any): any[] {
  const root = e8.fileNameAsDirectory(e8.expandFileName(property(":base-directory", project)));
  const entry = (f: string) => call(formatEntry, rel(f, root), style, project);
  if (style === "list") return ["unordered", ...files.map((f) => [entry(f)])];
  if (style === "tree") {
    const filesOnly = files.filter((f) => !isDirName(f));
    const directories = files.filter(isDirName);
    const subtree = (dir: string): any[] => [
      "unordered",
      ...filesOnly.filter((f) => e8.fileNameDirectory(f) === dir).map((f) => [entry(f)]),
      ...directories.filter((f) => e8.fileNameDirectory(e8.directoryFileName(f)) === dir).map((sub) => [entry(sub), subtree(sub)]),
    ];
    return subtree(root);
  }
  return e8.userError(`Unknown site-map style: \`${style}'`);
}

/** Write the sitemap of a project's files, as org-publish-sitemap. */
export function sitemap(project: Project, sitemapFilename = "sitemap.org"): void {
  const root = e8.fileNameAsDirectory(e8.expandFileName(property(":base-directory", project)));
  const file = e8.expandFileName(sitemapFilename, root);
  const title = property(":sitemap-title", project) ?? `Sitemap for project ${String(project[0])}`;
  const style = property(":sitemap-style", project) ?? "tree";
  const builder = property(":sitemap-function", project) ?? "org-publish-sitemap-default";
  const formatEntry = property(":sitemap-format-entry", project) ?? "org-publish-sitemap-default-entry";
  const sortFolders = sym(property(":sitemap-sort-folders", project, varValue("org-publish-sitemap-sort-folders")));
  const sortFiles = sym(property(":sitemap-sort-files", project, varValue("org-publish-sitemap-sort-files")));
  const ignoreCase = nonNil(property(":sitemap-ignore-case", project, varValue("org-publish-sitemap-sort-ignore-case")));
  const orgFileP = (f: string) => extension(f) === "org";
  const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  const lessEq = (a: string, b: string) => a === b || fold(a) <= fold(b);
  const predicate = (a: string, b: string): boolean => {
    let retval = true;
    if (sortFiles === "alphabetically") {
      const A = orgFileP(a) ? (e8.fileNameDirectory(a) ?? "") + findTitle(a, project) : a;
      const B = orgFileP(b) ? (e8.fileNameDirectory(b) ?? "") + findTitle(b, project) : b;
      retval = lessEq(A, B);
    } else if (sortFiles === "anti-chronologically" || sortFiles === "chronologically") {
      const [adate, bdate] = [findDate(a, project), findDate(b, project)];
      retval = !(sortFiles === "chronologically" ? bdate < adate : adate < bdate);
    } else if (!isNil(sortFiles)) e8.userError(`Invalid sort value ${sortFiles}`);
    if (sortFolders === "first" || sortFolders === "last") {
      if (e8.fileDirectoryP(a) && !e8.fileDirectoryP(b)) retval = sortFolders === "first";
      else if (!e8.fileDirectoryP(a) && e8.fileDirectoryP(b)) retval = sortFolders === "last";
    }
    return retval;
  };
  e8.message(`Generating sitemap for ${title}`);
  let files = getBaseFiles(project).filter((f) => f !== file);
  if (!(style === "list" && sortFolders === "ignore")) files = [...uniquify(files.map((f) => e8.fileNameDirectory(f) ?? "")).filter((d) => d !== root), ...files];
  if (!isNil(sortFiles) || sortFolders !== "ignore") files = [...files].sort((a, b) => (predicate(a, b) ? (predicate(b, a) ? 0 : -1) : 1));
  writeFile(file, String(call(builder, title, sitemapFilesToLisp(files, project, style, formatEntry))));
}

/** An export option's value in FILE, as the file's keywords set it, as org-publish-find-property; PROPERTY with or without its colon. */
export function findProperty(file: string, prop: string, project: Project, backend?: string): any {
  const f = expandIn(file, project);
  if (!e8.fileReadableP(f) || isDirName(f)) return undefined;
  return e8.letBind({ "org-inhibit-startup": true }, () =>
    withFileBuffer(f, () => {
      const env = nonNil(e8.variable("org-file-buffer-created")) ? getEnvironment(backend) : withBufferCopy(() => getEnvironment(backend));
      return env[prop.replace(/^:/, "")];
    }),
  );
}

/** A file's title, or its name without the directory or extension, as org-publish-find-title. */
export function findTitle(file: string, project: Project): string {
  const f = expandIn(file, project);
  const cached = cacheGetFileProperty(f, ":title", undefined, true);
  if (cached !== undefined && cached !== null) return cached;
  const parsed = findProperty(f, ":title", project);
  const title = !isNil(parsed) && !(Array.isArray(parsed) && parsed.length === 0) ? interpretData(parsed) : e8.fileNameNondirectory(sansExtension(f));
  return cacheSetFileProperty(f, ":title", title, undefined, true);
}

/** The time of an Org timestamp's text, midnight when it has none, in milliseconds, as org-time-string-to-time. */
function timeStringToTime(s: string): number | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[^\]>\d]*?(\d{1,2}):(\d{2}))?/.exec(s);
  if (!m) return undefined;
  return e8.encodeTime([0, m[5] === undefined ? 0 : +m[5], m[4] === undefined ? 0 : +m[4], +m[3], +m[2], +m[1], null, -1, null]) * 1000;
}

/** A file's #+DATE: as a time, or the time it was last changed, in milliseconds, as org-publish-find-date. */
export function findDate(file: string, project: Project): number {
  const f = expandIn(file, project);
  const cached = cacheGetFileProperty(f, ":date", undefined, true);
  if (cached !== undefined && cached !== null) return cached;
  let date: number | undefined;
  if (e8.fileDirectoryP(f)) date = e8.fileAttributes(f)!.modified;
  else {
    const parsed = findProperty(f, ":date", project);
    const ts = Array.isArray(parsed) ? (parsed as Datum[]).find((d) => typeof d !== "string" && d.type === "timestamp") : undefined;
    const value = ts ? interpretData(ts) : undefined;
    date = value && /\S/.test(value) ? timeStringToTime(value) : undefined;
    if (date === undefined) {
      if (e8.fileExistsP(f)) date = e8.fileAttributes(f)!.modified;
      else err(`No such file: "${f}"`);
    }
  }
  return cacheSetFileProperty(f, ":date", date, undefined, true);
}

/** A sitemap's entry for a file, a link titled with the file's title, or for a directory its name, as org-publish-sitemap-default-entry. */
export function sitemapDefaultEntry(entry: string, style: string, project: Project): string {
  if (!isDirName(entry)) return `[[file:${entry}][${findTitle(entry, project)}]]`;
  if (sym(style) === "tree") return e8.fileNameNondirectory(e8.directoryFileName(entry));
  return entry;
}

/** A sitemap: its title and the list of its files, as org-publish-sitemap-default. */
export function sitemapDefault(title: string, list: any[]): string {
  return `#+TITLE: ${title}\n\n${listToOrg(list)}`;
}

// --- Commands --------------------------------------------------------------------

function withTimestamps<T>(force: boolean, body: () => T): T {
  return e8.saveWindowExcursion(() => e8.letBind({ "org-publish-use-timestamps-flag": !force && nonNil(varValue("org-publish-use-timestamps-flag")) }, body));
}

/** Publish PROJECT, a project or its name, every file with FORCE, as org-publish. */
export function publish(project: Project | string, force = false): void {
  const p = typeof project === "string" ? assoc(project) : project;
  if (!p) return;
  withTimestamps(force, () => publishProjects([p]));
}

const projectNames = () => projects().map((p) => String(p[0]));

for (const name of ["org-publish", "org-publish-project"])
  e8.defineCommand({
    name,
    doc: "Publish PROJECT, a project's name or the project.\n\nWith a prefix argument, FORCE publishing every file, changed or not. ASYNC is accepted and ignored: E8 publishes in the foreground.",
    params: [
      { name: "project", prompt: "Publish project: ", collection: projectNames, requireMatch: true },
      { name: "force", kind: "prefix" },
      { name: "async", kind: "prefix" },
    ],
    run: (project: any, force: unknown) => publish(Array.isArray(project) ? project : String(project), flag(force)),
  });

e8.defineCommand({
  name: "org-publish-all",
  doc: "Publish all projects.\n\nWith a prefix argument, FORCE: remove all files in the timestamp directory and publish every file. ASYNC is accepted and ignored.",
  params: [
    { name: "force", kind: "prefix" },
    { name: "async", kind: "prefix" },
  ],
  run: (force: unknown) => {
    if (flag(force)) removeAllTimestamps();
    withTimestamps(flag(force), () => publishProjects(projects()));
  },
});

e8.defineCommand({
  name: "org-publish-current-file",
  doc: "Publish the current file.\n\nWith a prefix argument, FORCE publishing it though it has not changed. ASYNC is accepted and ignored.",
  params: [
    { name: "force", kind: "prefix" },
    { name: "async", kind: "prefix" },
  ],
  run: (force: unknown) => {
    const file = e8.bufferFileName();
    withTimestamps(flag(force), () => publishFile(file ?? e8.userError("Buffer is not visiting a file")));
  },
});

e8.defineCommand({
  name: "org-publish-current-project",
  doc: "Publish the project the current file belongs to.\n\nWith a prefix argument, FORCE publishing every file of the project. ASYNC is accepted and ignored.",
  params: [
    { name: "force", kind: "prefix" },
    { name: "async", kind: "prefix" },
  ],
  run: (force: unknown) =>
    e8.saveWindowExcursion(() => {
      const file = e8.bufferFileName();
      const project = file ? getProjectFromFilename(file, true) : undefined;
      if (project) publish(project, flag(force));
      else err(`File ${file} is not part of any known project`);
    }),
});

// --- The index -------------------------------------------------------------------

/** Keep the #+INDEX: terms of the file exported in the cache, as org-publish-collect-index, a final output filter. */
function collectIndex(output: string, _backend: unknown, info: Info): string {
  const file = e8.fileTruename(info["input-file"]);
  const seen = new Set<string>();
  const index = map(info["parse-tree"], "keyword", (k) => {
    const kw = k as Node;
    if (kw.p.key !== "INDEX") return undefined;
    const parent = lineage(kw, ["headline"])[0] as Node | undefined;
    let ref: [string, string] | null = null;
    if (parent) {
      if (parent.p["ID"]) ref = ["id", parent.p["ID"]];
      else if (parent.p["CUSTOM_ID"]) ref = ["custom-id", parent.p["CUSTOM_ID"]];
      else ref = ["name", String(parent.p["raw-value"]).replace(/\[[0-9]+%\]|\[[0-9]+\/[0-9]+\]/g, "")];
    }
    const term = [kw.p.value, file, ref];
    const key = JSON.stringify(term);
    if (seen.has(key)) return undefined;
    seen.add(key);
    return term;
  });
  cacheSetFileProperty(file, ":index", index, undefined, true);
  return output;
}

/** Write theindex.inc from every file's index terms, and theindex.org if there is none, as org-publish-index-generate-theindex. */
function indexGenerateTheindex(project: Project, directory: string): void {
  let full: any[] = [];
  for (const file of getBaseFiles(project)) {
    const index = (cacheGetFileProperty(file, ":index") ?? []) as any[];
    for (const term of index) if (!full.some((t) => JSON.stringify(t) === JSON.stringify(term))) full.unshift(term);
  }
  full = full.reverse().sort((a, b) => {
    const [x, y] = [String(a[0]).toLowerCase(), String(b[0]).toLowerCase()];
    return x < y ? -1 : y < x ? 1 : 0;
  });
  let out = "";
  let currentLetter: string | undefined;
  let lastEntry: string[] = [];
  for (const idx of full) {
    const entry = String(idx[0]).split("!").filter((s) => s !== "");
    const letter = entry[0].slice(0, 1).toUpperCase();
    const file = relativeName(idx[1], plistGet(project.slice(1), ":base-directory"));
    if (letter !== currentLetter) out += `* ${letter}\n`;
    let rank: number;
    if (JSON.stringify(entry) === JSON.stringify(lastEntry)) rank = entry.length - 1;
    else {
      rank = entry.length;
      for (let n = 0; n <= entry.length; n++)
        if (entry[n] !== lastEntry[n]) {
          rank = n;
          break;
        }
    }
    const len = Math.max(0, entry.length - rank);
    for (let n = 0; n < len; n++) {
      let text: string;
      if (n !== len - 1) text = entry[rank + n];
      else {
        const target = idx[2] as [string, string] | null;
        const dest = !target ? `file:${file}` : target[0] === "id" ? `id:${target[1]}` : target[0] === "custom-id" ? `file:${file}::#${target[1]}` : `file:${file}::*${target[1]}`;
        text = `[[${dest}][${entry[entry.length - 1]}]]`;
      }
      out += " ".repeat((rank + n) * 2) + "  - " + text + "\n";
    }
    currentLetter = letter;
    lastEntry = entry;
  }
  writeFile(e8.expandFileName("theindex.inc", directory), out);
  const indexOrg = e8.expandFileName("theindex.org", directory);
  if (!e8.fileExistsP(indexOrg)) writeFile(indexOrg, '#+TITLE: Index\n\n#+INCLUDE: "theindex.inc"\n\n');
}

// --- Links to other files of a project -------------------------------------------

/** Keep the references the export made to search cells, so links from other files find them, as org-publish--store-crossrefs. */
function storeCrossrefs(output: string, _backend: unknown, info: Info): string {
  const refs: Map<any, any> = info["internal-references"] ?? new Map();
  const crossrefs: [string, number][] = [];
  for (const [k, v] of refs) if (typeof k === "string" && k.startsWith("cell:")) crossrefs.push([k.slice(5), v]);
  cacheSetFileProperty(e8.fileTruename(info["input-file"]), ":crossrefs", crossrefs);
  return output;
}

/**
 * The reference of the element SEARCH finds in FILE, as
 * org-publish-resolve-external-link: with PREFER-CUSTOM, a heading's
 * CUSTOM_ID; else the number its file was or will be published with,
 * kept in the cache.
 */
export function resolveExternalLink(search: string, file: string, preferCustom = false): string {
  if (preferCustom) {
    const custom = search.startsWith("#")
      ? search.slice(1)
      : e8.withCurrentBuffer(e8.findFileNoselect(file), () =>
          e8.saveExcursion(() => {
            let pos: number;
            try {
              pos = searchInBuffer(search);
            } catch (e) {
              return brokenLink(e instanceof Error ? e.message : String(e));
            }
            e8.gotoChar(pos);
            if (!e8.derivedModeP("org-mode") || !e8.lookingAt("\\*+ ")) return undefined;
            const id = entryGet(e8.lineOf(pos), "CUSTOM_ID");
            return id && /\S/.test(id) ? id : undefined;
          }),
        );
    if (custom) return custom;
  }
  if (!cache) {
    e8.message(`Reference ${S(search)} in file ${S(file)} cannot be resolved without publishing`);
    return "MissingReference";
  }
  const filename = e8.fileTruename(file);
  const crossrefs: [string, number][] = cacheGetFileProperty(filename, ":crossrefs", undefined, true) ?? [];
  const cells = stringToSearchCell(search);
  for (const c of cells) {
    const known = crossrefs.find(([k]) => k === c);
    if (known) return formatReference(known[1]);
  }
  const neu = newReference(new Map(crossrefs.map(([k, v]) => ["cell:" + k, v])));
  const updated: [string, number][] = [...cells.map((c) => [c, neu] as [string, number]).reverse(), ...crossrefs];
  cacheSetFileProperty(filename, ":crossrefs", updated);
  return formatReference(neu);
}

/** A file name relative to the project's base directory while publishing, as org-publish-file-relative-name. */
export function fileRelativeName(filename: string, info: Info): string {
  const base = info["base-directory"];
  if (base && e8.fileNameAbsoluteP(filename) && e8.expandFileName(filename).startsWith(e8.fileNameAsDirectory(e8.expandFileName(base)))) return relativeName(filename, base);
  return filename;
}

// --- The cache -------------------------------------------------------------------

/** org-publish-cache: the timestamps and each file's properties, of the project being published. */
let cache: Map<string, any> | undefined;
/** org-publish-transient-cache: what is kept only while publishing. */
let transient: Map<string, any> | undefined;

const transientKey = (file: string, prop: string) => file + "\0" + prop;

/** Write the cache to its file, as org-publish-write-cache-file. */
export function writeCacheFile(freeCache = false): void {
  if (!cache) err("`org-publish-write-cache-file' called, but no cache present");
  const file = cacheGet(":cache-file:");
  if (!file) err("Cannot find cache-file name in `org-publish-write-cache-file'");
  writeFile(file, JSON.stringify(Object.fromEntries(cache!), null, 1) + "\n");
  if (freeCache) resetCache();
}

/** Load the project's cache, or make it, as org-publish-initialize-cache. */
export function initializeCache(projectName: string): Map<string, any> {
  if (!projectName) err("Cannot initialize `org-publish-cache' without projects name in `org-publish-initialize-cache'");
  const dir = String(varValue("org-publish-timestamp-directory"));
  if (!e8.fileExistsP(dir)) e8.makeDirectory(dir, { parents: true });
  if (!e8.fileDirectoryP(dir)) err(`Org publish timestamp: ${dir} is not a directory`);
  transient ??= new Map();
  if (!(cache && cacheGet(":project:") === projectName)) {
    const cacheFile = e8.fileNameAsDirectory(e8.expandFileName(dir)) + projectName + ".e8.json";
    const exists = e8.fileExistsP(cacheFile);
    if (cache) resetCache();
    let loaded: Map<string, any> | undefined;
    if (exists) {
      try {
        loaded = new Map(Object.entries(JSON.parse(readFile(cacheFile))));
      } catch {
        loaded = undefined;
      }
    }
    if (loaded) cache = loaded;
    else {
      cache = new Map();
      cacheSet(":project:", projectName);
      cacheSet(":cache-file:", cacheFile);
    }
    transient ??= new Map();
    if (!loaded) writeCacheFile();
  }
  return cache!;
}

/** Empty the caches, as org-publish-reset-cache. */
export function resetCache(): void {
  e8.message("Resetting org-publish-cache");
  cache?.clear();
  transient?.clear();
  cache = undefined;
}

/** Whether FILENAME changed since it was last published, or a file it includes did, as org-publish-cache-file-needs-publishing. */
function cacheFileNeedsPublishing(filename: string, pubDir?: string, pubFunc?: any, _baseDir?: string): boolean {
  if (!cache) err("`org-publish-cache-file-needs-publishing' called, but no cache present");
  const pstamp = cacheGet(timestampFilename(filename, pubDir, pubFunc));
  const included: number[] = [];
  if (extension(filename) === "org") {
    const buffer = e8.generateNewBufferName(" *temp*");
    e8.getBufferCreate(buffer);
    try {
      e8.withCurrentBuffer(buffer, () => {
        e8.letBind({ "org-inhibit-startup": true, "delay-mode-hooks": true }, () => e8.call("org-mode"));
        e8.insertFileContents(filename);
        for (const k of map(parseBuffer(), "keyword", (x) => x as Node)) {
          if (k.p.key !== "INCLUDE") continue;
          const m = /^("(.+?)"|\S+)/.exec(k.p.value ?? "");
          if (!m) continue;
          const name = (m[2] ?? m[1]).replace(/::.*?$/, "");
          included.push(mtimeOfSrc(e8.expandFileName(name, e8.fileNameDirectory(filename) ?? undefined)));
        }
      });
    } finally {
      e8.call("kill-buffer", buffer);
    }
  }
  if (pstamp === undefined || pstamp === null) return true;
  const mtime = mtimeOfSrc(filename);
  return pstamp < mtime || included.some((ct) => mtime < ct);
}

/** Set a property of FILENAME in the cache, or with TRANSIENT only while publishing; returns VALUE. */
export function cacheSetFileProperty(filename: string, prop: string, value: any, projectName?: string, isTransient = false): any {
  if (projectName) initializeCache(projectName);
  if (isTransient) {
    transient ??= new Map();
    transient.set(transientKey(filename, prop), value);
    return value;
  }
  const pl = cacheGet(filename);
  if (pl) {
    pl[prop] = value;
    return value;
  }
  return cacheGetFileProperty(filename, prop, value, false, projectName);
}

/** A property of FILENAME in the cache, or DEFAULT, made unless NO-CREATE, as org-publish-cache-get-file-property. */
export function cacheGetFileProperty(filename: string, prop: string, dflt?: any, noCreate = false, projectName?: string): any {
  if (projectName) initializeCache(projectName);
  const t = transient?.get(transientKey(filename, prop));
  if (t !== undefined && t !== null && t !== false) return t;
  const properties = cacheGet(filename);
  if (!properties) {
    if (!noCreate) cacheSet(filename, { [prop]: dflt ?? null });
    return dflt;
  }
  return prop in properties ? properties[prop] : dflt;
}

export function cacheGet(key: string): any {
  if (!cache) err("`org-publish-cache-get' called, but no cache present");
  return cache!.get(key);
}

export function cacheSet(key: string, value: any): any {
  if (!cache) err("`org-publish-cache-set' called, but no cache present");
  cache!.set(key, value);
  return value;
}

/** When a file was last changed, in milliseconds, following a symbolic link, as org-publish-cache-mtime-of-src. */
function mtimeOfSrc(file: string): number {
  const target = e8.fileSymlinkP(file);
  const attr = e8.fileAttributes(e8.expandFileName(target ?? file, e8.fileNameDirectory(file) ?? undefined));
  if (!attr) err(`No such file: ${S(file)}`);
  return attr!.modified;
}

// The functions projects and Org's other files name.
e8.defun("org-publish-org-to", (backend: any, filename: string, ext: string, plist: e8.Value[], pubDir?: string) => publishOrgTo(String(sym(backend)), filename, ext, plist, pubDir));
e8.defun("org-publish-attachment", (plist: e8.Value[], filename: string, pubDir: string) => publishAttachment(plist, filename, pubDir));
e8.defun("org-publish-sitemap-default-entry", (entry: string, style: any, project: Project) => sitemapDefaultEntry(entry, style, project));
e8.defun("org-publish-sitemap-default", (title: string, list: any[]) => sitemapDefault(title, list));
e8.defun("org-publish-find-title", (file: string, project: Project) => findTitle(file, project));
e8.defun("org-publish-find-date", (file: string, project: Project) => findDate(file, project));
e8.defun("org-publish-find-property", (file: string, prop: any, project: Project, backend?: any) => findProperty(file, String(sym(prop)), project, backend == null ? undefined : String(sym(backend))));
e8.defun("org-publish-file", (filename: string, project?: Project, noCache?: unknown) => publishFile(filename, project ?? undefined, flag(noCache)));
e8.defun("org-publish-projects", (list: Project[]) => publishProjects(list));
e8.defun("org-publish-get-project-from-filename", (filename: string, up?: unknown) => getProjectFromFilename(filename, flag(up)) ?? null);
e8.defun("org-publish-remove-all-timestamps", () => removeAllTimestamps());
e8.defun("org-publish-resolve-external-link", (search: string, file: string, preferCustom?: unknown) => resolveExternalLink(search, file, flag(preferCustom)));
