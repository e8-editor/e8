// Packages from their git repositories, after Emacs's package-vc.el, as
// ADR 0059 describes: a package is a repository, its versions are its tags,
// installing it is a clone into package-user-dir, and activating it puts the
// checkout on load-path. What is installed, and at which commit, is kept in
// a lock file beside init.ts, so a configuration reproduces elsewhere.
//
// A configuration names its packages with e8.usePackage (use-package.ts);
// M-x package-vc-install, package-vc-upgrade, package-vc-upgrade-all and
// package-delete manage them by hand. Only these commands, and installing a
// package a configuration names that is not there yet, use the network:
// starting E8 with its packages installed runs no git at all. On a machine
// that has the lock file but not the packages, the first package asked for
// clones every package the lock file names at once, as cloning them one by
// one would hold startup up for seconds each.
//
// Preloaded, for its commands, which Emacs autoloads; it runs nothing until
// one is used.

e8.defineVariable({
  name: "package-user-dir",
  doc: "The directory packages are installed in, each in a directory named after it; nil for repos/ in user-emacs-directory, where Emacs's is elpa/.",
  value: null,
});

e8.defineVariable({
  name: "package-vc-lock-file",
  doc: "The file that records each installed package's source, version and commit; nil for e8-lock.json in user-emacs-directory. Keep it with init.ts so another machine installs the same commits.",
  value: null,
});

e8.defineVariable({
  name: "vc-git-program",
  doc: "The git program, as Emacs's vc-git-program: package-vc runs it to install and upgrade packages.",
  value: "git",
});

e8.defineError("package-error", "error");

/** What `e8-package.json` says about a package. */
export interface Manifest {
  name: string;
  description?: string;
  /** The oldest E8 it runs on. */
  e8?: string;
  /** The packages it needs, each a source and the oldest version: "e8-editor/e8-magit-section@0.1.0". */
  requires?: Record<string, string>;
}

/** A package's line in the lock file. */
export interface LockEntry {
  /** The source as the configuration or command gave it. */
  source: string;
  url: string;
  /** The revision asked for, a tag, a branch or a commit; none for the newest tag. */
  rev?: string;
  /** The version tag the commit has, if any. */
  tag?: string;
  /** The branch followed, if the checkout follows one. */
  branch?: string;
  commit: string;
}

interface LockFile {
  version: 1;
  packages: Record<string, LockEntry>;
}

function fail(message: string): never {
  return e8.signal("package-error", message);
}

/** A package's name: a directory in package-user-dir, so never "." or "..", nor a path. */
const NAME = /^[A-Za-z0-9][\w.+-]*$/;

/**
 * Refuses a source or revision git would read as an option: a manifest
 * names its requirements' sources, and a manifest is the package author's,
 * not the user's.
 */
function checkArgument(what: string, value: string): string {
  if (value.startsWith("-") || value.includes("\n")) fail(`Not a usable ${what}: ${value}`);
  return value;
}

function userEmacsFile(name: string): string {
  const base = e8.variable("user-emacs-directory");
  if (typeof base !== "string" || base === "") fail(`Cannot find ${name}: user-emacs-directory is not set`);
  return e8.expandFileName(name, base);
}

/** The directory packages are installed in, with a slash at its end. */
export function packageUserDir(): string {
  const dir = e8.variable("package-user-dir");
  return e8.fileNameAsDirectory(typeof dir === "string" && dir !== "" ? e8.expandFileName(dir) : userEmacsFile("repos"));
}

function lockFileName(): string {
  const file = e8.variable("package-vc-lock-file");
  return typeof file === "string" && file !== "" ? e8.expandFileName(file) : userEmacsFile("e8-lock.json");
}

/** The directory a package is installed in, whether or not it is. */
export function packageDir(name: string): string {
  return packageUserDir() + name;
}

// Git

function gitProgram(): string {
  const program = e8.variable("vc-git-program");
  return typeof program === "string" && program !== "" ? program : "git";
}

/**
 * Runs git in `dir`, giving its exit status and output. It never asks for a
 * password, which it would ask on a terminal E8 may be drawing on.
 */
function runGit(args: string[], dir?: string): { exit: number; output: string } {
  return e8.callProcess(["env", "GIT_TERMINAL_PROMPT=0", gitProgram(), ...args], dir === undefined ? {} : { directory: dir });
}

function git(args: string[], dir?: string): string {
  const r = runGit(args, dir);
  if (r.exit !== 0) fail(`git ${args.join(" ")} failed: ${r.output.trim()}`);
  return r.output.trim();
}

/** The commit a checkout is at, read from .git without running git. */
export function checkoutCommit(dir: string): string | undefined {
  const gitDir = e8.fileNameAsDirectory(dir) + ".git/";
  if (!e8.fileExists(gitDir + "HEAD")) return undefined;
  const head = e8.readTextFile(gitDir + "HEAD").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5);
  if (e8.fileExists(gitDir + ref)) return e8.readTextFile(gitDir + ref).trim();
  if (e8.fileExists(gitDir + "packed-refs")) {
    for (const line of e8.readTextFile(gitDir + "packed-refs").split("\n")) {
      const [commit, name] = line.split(" ");
      if (name === ref) return commit;
    }
  }
  return undefined;
}

// Versions

/** A version tag's numbers, "v0.3.1" as [0, 3, 1], or none for a tag that is not a version. */
export function parseVersion(tag: string): number[] | undefined {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(tag);
  return m === null ? undefined : m[1].split(".").map(Number);
}

/** Compares two versions as numbers, missing parts counting as 0, as version-list-<. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest version tag of a checkout. */
function newestTag(dir: string): string | undefined {
  const tags = git(["tag", "--list"], dir)
    .split("\n")
    .filter((t) => parseVersion(t) !== undefined);
  tags.sort((a, b) => compareVersions(parseVersion(b)!, parseVersion(a)!));
  return tags[0];
}

function versionTagAt(dir: string): string | undefined {
  const tags = git(["tag", "--points-at", "HEAD"], dir)
    .split("\n")
    .filter((t) => parseVersion(t) !== undefined);
  tags.sort((a, b) => compareVersions(parseVersion(b)!, parseVersion(a)!));
  return tags[0];
}

function isRemoteBranch(dir: string, rev: string): boolean {
  return runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${rev}`], dir).exit === 0;
}

function currentBranch(dir: string): string | undefined {
  const r = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
  return r.exit === 0 ? r.output.trim() : undefined;
}

/**
 * Puts a checkout at a commit, if given, else at a revision, else at the
 * newest version tag, or on the default branch if there is none.
 */
function checkOut(dir: string, rev: string | undefined, commit: string | undefined): void {
  if (commit !== undefined) {
    if (runGit(["cat-file", "-e", `${commit}^{commit}`], dir).exit !== 0) git(["fetch", "--quiet", "--tags", "origin"], dir);
    if (rev !== undefined && isRemoteBranch(dir, rev)) {
      git(["checkout", "--quiet", "-B", rev, commit], dir);
      git(["branch", "--quiet", "--set-upstream-to", `origin/${rev}`], dir);
    } else {
      git(["checkout", "--quiet", "--detach", commit], dir);
    }
    return;
  }
  if (rev !== undefined) {
    if (isRemoteBranch(dir, rev)) {
      if (currentBranch(dir) === rev) git(["merge", "--quiet", "--ff-only", `origin/${rev}`], dir);
      else git(["checkout", "--quiet", "-B", rev, "--track", `origin/${rev}`], dir);
    } else {
      git(["checkout", "--quiet", "--detach", rev], dir);
    }
    return;
  }
  const tag = newestTag(dir);
  if (tag !== undefined) git(["checkout", "--quiet", "--detach", tag], dir);
}

/** Where a checkout is, as the lock file records it. */
function describe(dir: string, source: string, url: string, rev: string | undefined): LockEntry {
  const entry: LockEntry = { source, url, commit: git(["rev-parse", "HEAD"], dir) };
  if (rev !== undefined) entry.rev = rev;
  const tag = versionTagAt(dir);
  if (tag !== undefined) entry.tag = tag;
  const branch = currentBranch(dir);
  if (branch !== undefined) entry.branch = branch;
  return entry;
}

// Sources

/**
 * Where a package's repository is: `owner/name` is a GitHub repository, and
 * anything else a URL or a directory git can clone.
 */
export function sourceUrl(source: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(source) && !e8.fileExists(source) ? `https://github.com/${source}.git` : source;
}

/** A repository's name, from the last part of its URL. */
export function repositoryName(url: string): string {
  return url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? url;
}

/** Splits a requirement, "owner/name@0.1.0", into its source and oldest version. */
export function parseRequirement(requirement: string): { source: string; version?: number[] } {
  const at = requirement.lastIndexOf("@");
  const version = at < 0 ? undefined : parseVersion(requirement.slice(at + 1));
  return version === undefined ? { source: requirement } : { source: requirement.slice(0, at), version };
}

/**
 * A checkout's manifest; for a repository that has none, a package named
 * after the repository with nothing more said.
 */
export function readManifest(dir: string, url: string): Manifest {
  const file = e8.fileNameAsDirectory(dir) + "e8-package.json";
  if (!e8.fileExists(file)) return { name: repositoryName(url) };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(e8.readTextFile(file)) as Manifest;
  } catch (e) {
    return fail(`${url}: e8-package.json is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof manifest.name !== "string" || !NAME.test(manifest.name)) fail(`${url}: e8-package.json has no usable "name"`);
  for (const [name, requirement] of Object.entries(manifest.requires ?? {})) {
    if (!NAME.test(name) || typeof requirement !== "string") fail(`${url}: e8-package.json requires ${JSON.stringify(name)}, which is not usable`);
  }
  return manifest;
}

function checkE8Version(manifest: Manifest): void {
  if (manifest.e8 === undefined) return;
  const needed = parseVersion(manifest.e8);
  const running = parseVersion(String(e8.variable("e8-version") ?? ""));
  if (needed === undefined) fail(`${manifest.name}: "e8" is not a version: ${manifest.e8}`);
  if (running !== undefined && compareVersions(running, needed) < 0) {
    fail(`${manifest.name} needs E8 ${manifest.e8} or newer; this is ${String(e8.variable("e8-version"))}`);
  }
}

// The lock file

export function readLock(): LockFile {
  const file = lockFileName();
  if (!e8.fileExists(file)) return { version: 1, packages: {} };
  try {
    const lock = JSON.parse(e8.readTextFile(file)) as LockFile;
    return { version: 1, packages: lock.packages ?? {} };
  } catch (e) {
    return fail(`${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function writeLock(lock: LockFile): void {
  const packages: Record<string, LockEntry> = {};
  for (const name of Object.keys(lock.packages).sort()) packages[name] = lock.packages[name];
  const file = lockFileName();
  e8.makeDirectory(e8.fileNameDirectory(file) ?? ".", { parents: true });
  e8.writeTextFile(file, JSON.stringify({ version: 1, packages }, null, 2) + "\n");
}

function setLockEntry(name: string, entry: LockEntry | undefined): void {
  const lock = readLock();
  if (entry === undefined) delete lock.packages[name];
  else lock.packages[name] = entry;
  writeLock(lock);
}

/** The installed package a source names, as the lock file records it. */
export function lockedPackage(source: string): string | undefined {
  const url = sourceUrl(source);
  const packages = readLock().packages;
  return Object.keys(packages).find((name) => packages[name].url === url);
}

// Installing

/** Puts an installed package's checkout on load-path, as package-activate. */
export function packageActivate(name: string): void {
  const dir = packageDir(name);
  const path = e8.variable("load-path");
  const dirs = Array.isArray(path) ? path.filter((d): d is string => typeof d === "string") : [];
  if (!dirs.some((d) => e8.directoryFileName(e8.expandFileName(d)) === dir)) e8.setVariable("load-path", [dir, ...dirs]);
}

/** The packages installed, by name. */
export function packageInstalledList(): string[] {
  return Object.keys(readLock().packages).filter((name) => e8.fileDirectoryP(packageDir(name)));
}

function installedVersion(name: string): number[] | undefined {
  const tag = readLock().packages[name]?.tag;
  return tag === undefined ? undefined : parseVersion(tag);
}

/**
 * Installs what a manifest requires and checks the versions installed. A
 * requirement installed at an older version than the manifest needs is
 * upgraded first, as Emacs's package manager upgrades a dependency, its
 * repository fetched unless FETCHED says it already is.
 */
function installRequirements(manifest: Manifest, seen: Set<string>, fetched = new Set<string>()): void {
  for (const [name, requirement] of Object.entries(manifest.requires ?? {})) {
    const { source, version } = parseRequirement(requirement);
    if (!e8.fileDirectoryP(packageDir(name))) installPackage(source, { seen });
    else packageActivate(name);
    const tooOld = (): number[] | undefined => {
      const have = installedVersion(name);
      return version !== undefined && have !== undefined && compareVersions(have, version) < 0 ? have : undefined;
    };
    if (tooOld() !== undefined && readLock().packages[name]?.rev === undefined) {
      if (!fetched.has(name)) {
        git(["fetch", "--quiet", "--tags", "origin"], packageDir(name));
        fetched.add(name);
      }
      upgradeFetched(name, fetched);
    }
    const have = tooOld();
    if (have !== undefined) fail(`${manifest.name} needs ${name} ${version!.join(".")} or newer; ${have.join(".")} is installed (M-x package-vc-upgrade)`);
  }
}

/**
 * Installs a package from its repository and activates it, giving its
 * name, as package-vc-install: at `rev` if given, else at the commit the
 * lock file records for it, else at its newest version tag. A package
 * already installed is put at that revision instead.
 */
export function installPackage(source: string, options: { rev?: string; name?: string; url?: string; seen?: Set<string> } = {}): string {
  const url = checkArgument("source", options.url ?? sourceUrl(source));
  if (options.rev !== undefined) checkArgument("revision", options.rev);
  const lock = readLock();
  const lockedName = Object.keys(lock.packages).find((n) => lock.packages[n].url === url);
  const locked = lockedName === undefined ? undefined : lock.packages[lockedName];
  // The locked commit holds unless the configuration now asks for another revision.
  const commit = locked !== undefined && locked.rev === options.rev ? locked.commit : undefined;
  const seen = options.seen ?? new Set<string>();
  if (seen.has(url)) fail(`${source} requires itself, through the packages it requires`);
  seen.add(url);

  const installed = lockedName !== undefined && e8.fileDirectoryP(packageDir(lockedName));
  let dir: string;
  let manifest: Manifest;
  if (installed) {
    dir = packageDir(lockedName);
    checkOut(dir, options.rev, commit);
    manifest = readManifest(dir, url);
  } else {
    e8.makeDirectory(packageUserDir(), { parents: true });
    const temporary = `${packageUserDir()}.installing-${repositoryName(url)}-${Date.now()}`;
    e8.message(`Installing ${source}...`);
    try {
      git(["clone", "--quiet", "--", url, temporary]);
      checkOut(temporary, options.rev, commit);
      manifest = readManifest(temporary, url);
      if (options.name !== undefined && options.name !== manifest.name) {
        fail(`${url} holds the package ${manifest.name}, not ${options.name}`);
      }
      checkE8Version(manifest);
      dir = packageDir(manifest.name);
      if (e8.fileExists(dir)) {
        fail(`${dir} is there already: delete it, or M-x package-delete ${manifest.name}, to install ${source}`);
      }
      e8.renameFile(temporary, dir);
    } catch (e) {
      if (e8.fileExists(temporary)) e8.deleteDirectory(temporary, { recursive: true, trash: false });
      throw e;
    }
  }
  checkE8Version(manifest);
  setLockEntry(manifest.name, describe(dir, source, url, options.rev));
  installRequirements(manifest, seen);
  packageActivate(manifest.name);
  if (!installed) e8.message(`Installed ${manifest.name}${versionLabel(manifest.name)}`);
  return manifest.name;
}

function versionLabel(name: string): string {
  const entry = readLock().packages[name];
  if (entry === undefined) return "";
  if (entry.tag !== undefined) return ` ${entry.tag}`;
  return ` ${entry.branch ?? ""}${entry.branch === undefined ? "" : " "}at ${entry.commit.slice(0, 7)}`;
}

/**
 * Makes sure a package a configuration names is installed and at the
 * commit the lock file records, without the network unless it has to
 * fetch, and activates it, giving its name.
 */
/** Whether this session has cloned what the lock file names and is missing. */
let lockedCloned = false;

/**
 * Clones, all at once, the packages the lock file names that are not
 * installed, as when a configuration and its lock file come to a new
 * machine: each is then checked out at its locked commit when the
 * configuration asks for it. One at a time, each clone took about two
 * seconds, nearly all of it reaching the host, so fourteen held startup up
 * for half a minute. A clone that fails is left for installPackage to try
 * again and report. Gives how many were cloned.
 */
export function cloneLockedPackages(): number {
  const missing = Object.entries(readLock().packages).filter(([name]) => !e8.fileExists(packageDir(name)));
  if (missing.length === 0) return 0;
  e8.makeDirectory(packageUserDir(), { parents: true });
  const progress = (done: number) => e8.message(`Installing ${missing.length} packages from e8-lock.json...${done > 0 ? ` ${done}/${missing.length}` : ""}`);
  progress(0);
  // Each clone's sentinel says how it ended, "finished\n" when it worked.
  const ended: { name: string; temporary: string; ok: boolean }[] = [];
  for (const [name, entry] of missing) {
    const temporary = `${packageUserDir()}.installing-${name}-${Date.now()}`;
    try {
      e8.makeProcess({
        name: `git clone ${name}`,
        command: ["env", "GIT_TERMINAL_PROMPT=0", gitProgram(), "clone", "--quiet", "--", entry.url, temporary],
        connectionType: "pipe",
        filter: () => {},
        sentinel: (_process, event) => ended.push({ name, temporary, ok: event === "finished\n" }),
      });
    } catch {
      // As a clone that failed: installPackage tries it again and says why.
      ended.push({ name, temporary, ok: false });
    }
  }
  let cloned = 0;
  let done = 0;
  while (done < missing.length) {
    e8.acceptProcessOutput(undefined, 0.05);
    for (const { name, temporary, ok } of ended.splice(0)) {
      done++;
      if (ok && !e8.fileExists(packageDir(name))) {
        e8.renameFile(temporary, packageDir(name));
        cloned++;
      } else if (e8.fileExists(temporary)) {
        e8.deleteDirectory(temporary, { recursive: true, trash: false });
      }
      progress(done);
    }
  }
  return cloned;
}

export function ensurePackage(source: string, options: { rev?: string; name?: string; url?: string } = {}): string {
  if (!lockedCloned) {
    lockedCloned = true;
    cloneLockedPackages();
  }
  const url = options.url ?? sourceUrl(source);
  const lock = readLock();
  const name = Object.keys(lock.packages).find((n) => lock.packages[n].url === url);
  if (name !== undefined) {
    const entry = lock.packages[name];
    const dir = packageDir(name);
    if (e8.fileDirectoryP(dir) && entry.rev === options.rev && checkoutCommit(dir) === entry.commit) {
      for (const requirement of Object.values(readManifest(dir, url).requires ?? {})) {
        const required = lockedPackage(parseRequirement(requirement).source);
        if (required !== undefined && e8.fileDirectoryP(packageDir(required))) packageActivate(required);
        else ensurePackage(parseRequirement(requirement).source);
      }
      packageActivate(name);
      return name;
    }
  }
  return installPackage(source, options);
}

// Upgrading and deleting

/**
 * Brings an installed package up to date, as package-vc-upgrade: to the
 * newest version tag, or the head of the branch it follows. A package
 * pinned to a tag or commit stays. Gives a description of the change.
 * It fetches with git while E8 waits; the commands fetch in the background
 * with fetchPackages, then call upgradeFetched.
 */
export function upgradePackage(name: string): string {
  const entry = readLock().packages[name];
  if (entry === undefined || !e8.fileDirectoryP(packageDir(name))) fail(`${name} is not installed`);
  git(["fetch", "--quiet", "--tags", "origin"], packageDir(name));
  return upgradeFetched(name, new Set([name]));
}

/**
 * Brings an installed package whose repository is fetched up to date, as
 * upgradePackage does after fetching, upgrading what it requires that is
 * too old; FETCHED names the packages already fetched.
 */
export function upgradeFetched(name: string, fetched: Set<string>): string {
  const entry = readLock().packages[name];
  const dir = packageDir(name);
  if (entry === undefined || !e8.fileDirectoryP(dir)) fail(`${name} is not installed`);
  const old = entry.commit;
  const oldLabel = versionLabel(name).trim();
  if (entry.rev !== undefined && !isRemoteBranch(dir, entry.rev)) return `${name} is pinned to ${entry.rev}`;
  if (entry.rev !== undefined) checkOut(dir, entry.rev, undefined);
  else if (newestTag(dir) !== undefined) checkOut(dir, undefined, undefined);
  else git(["merge", "--quiet", "--ff-only", "@{upstream}"], dir);
  const manifest = readManifest(dir, entry.url);
  try {
    checkE8Version(manifest);
  } catch (e) {
    git(["checkout", "--quiet", "--detach", old], dir);
    throw e;
  }
  setLockEntry(name, describe(dir, entry.source, entry.url, entry.rev));
  installRequirements(manifest, new Set([entry.url]), fetched);
  const now = readLock().packages[name].commit;
  if (now === old) return `${name} is up to date`;
  const commits = git(["rev-list", "--count", `${old}..${now}`], dir);
  return `${name}: ${oldLabel} -> ${versionLabel(name).trim()} (${commits} commit${commits === "1" ? "" : "s"}); restart E8 to load it`;
}

/**
 * Fetches the repositories of the installed packages NAMES in the
 * background, all at once, saying how many are done, then calls DONE with
 * those whose fetch failed and why, so the editor does not wait on the
 * network, as startup clones the lock file's packages all at once.
 */
export function fetchPackages(names: string[], done: (failed: Map<string, string>) => void): void {
  const failed = new Map<string, string>();
  let left = names.length;
  const progress = () => e8.message(`Fetching ${names.length} package${names.length === 1 ? "" : "s"}...${left < names.length ? ` ${names.length - left}/${names.length}` : ""}`);
  const finish = (name: string, error?: string) => {
    if (error !== undefined) failed.set(name, error);
    left--;
    if (left > 0) return progress();
    done(failed);
  };
  if (names.length === 0) return done(failed);
  progress();
  for (const name of names) {
    let output = "";
    try {
      e8.makeProcess({
        name: `git fetch ${name}`,
        command: ["env", "GIT_TERMINAL_PROMPT=0", gitProgram(), "-C", packageDir(name), "fetch", "--quiet", "--tags", "origin"],
        connectionType: "pipe",
        filter: (_process, text) => {
          output += text;
        },
        sentinel: (_process, event) => finish(name, event === "finished\n" ? undefined : output.trim() || event.trim()),
      });
    } catch (e) {
      finish(name, String(e));
    }
  }
}

/** NAMES ordered so that what a package requires comes before it, for upgrading. */
function requirementsFirst(names: string[]): string[] {
  const ordered: string[] = [];
  const visit = (name: string, path: Set<string>) => {
    if (ordered.includes(name) || path.has(name) || !names.includes(name)) return;
    path.add(name);
    const entry = readLock().packages[name];
    for (const required of Object.keys(entry === undefined ? {} : (readManifest(packageDir(name), entry.url).requires ?? {}))) visit(required, path);
    ordered.push(name);
  };
  for (const name of names) visit(name, new Set());
  return ordered;
}

/** Upgrades the fetched packages NAMES, giving a line for each, an error's for one that failed. */
function upgradeEach(names: string[], failed: Map<string, string>): string[] {
  const fetched = new Set(names.filter((n) => !failed.has(n)));
  return requirementsFirst(names).map((name) => {
    if (failed.has(name)) return `${name}: fetching failed: ${failed.get(name)}`;
    try {
      return upgradeFetched(name, fetched);
    } catch (e) {
      return `${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}

function dependents(name: string): string[] {
  const packages = readLock().packages;
  return packageInstalledList().filter((other) => other !== name && Object.keys(readManifest(packageDir(other), packages[other].url).requires ?? {}).includes(name));
}

/** Deletes an installed package, as package-delete, unless another needs it. */
export function deletePackage(name: string): void {
  const needed = dependents(name);
  if (needed.length > 0) fail(`Package ${name} is a dependency of ${needed.join(", ")}`);
  const dir = packageDir(name);
  if (e8.fileDirectoryP(dir)) e8.deleteDirectory(dir, { recursive: true, trash: false });
  setLockEntry(name, undefined);
  const path = e8.variable("load-path");
  if (Array.isArray(path)) e8.setVariable("load-path", path.filter((d) => typeof d !== "string" || e8.expandFileName(d) !== dir));
}

// Commands

e8.defineCommand({
  name: "package-vc-install",
  doc: "Install a package from its git repository, owner/name on GitHub or a URL, at its newest version tag; with a prefix argument, ask for the revision, a tag, branch or commit.",
  params: [
    { name: "source", prompt: "Install package from (owner/name or URL): ", history: "package-vc--install-history" },
    { name: "arg", kind: "prefix" },
  ],
  run: (source: string, arg: e8.PrefixArg) => {
    if (source.trim() === "") e8.userError("No package given");
    const rev = arg === null || arg === undefined ? undefined : e8.readString("Revision: ");
    const name = installPackage(source.trim(), rev === undefined || rev === "" ? {} : { rev });
    e8.message(`Installed ${name}${versionLabel(name)}`);
  },
});

e8.defineCommand({
  name: "package-vc-upgrade",
  doc: "Upgrade an installed package to its newest version tag, or the head of the branch it follows, as the lock file records, and what it requires that is too old. Its repository is fetched in the background, so E8 does not wait on the network; the result is said when it is done.",
  params: [{ name: "name", prompt: "Upgrade package: ", collection: () => packageInstalledList(), requireMatch: true }],
  run: (name: string) => {
    if (readLock().packages[name] === undefined || !e8.fileDirectoryP(packageDir(name))) fail(`${name} is not installed`);
    // Fetched in the background; the upgrade itself is quick.
    fetchPackages([name], (failed) => e8.message(upgradeEach([name], failed).join("\n")));
  },
});

e8.defineCommand({
  name: "package-vc-upgrade-all",
  doc: "Upgrade every installed package, as package-vc-upgrade does each: their repositories fetched in the background all at once, then each upgraded, what a package requires before it.",
  run: () => {
    const names = packageInstalledList();
    if (names.length === 0) return void e8.message("No packages are installed");
    // All fetched at once in the background, then upgraded, what a
    // package requires before it.
    fetchPackages(names, (failed) => e8.message(upgradeEach(names, failed).join("\n")));
  },
});

e8.defineCommand({
  name: "package-delete",
  doc: "Delete an installed package and its line in the lock file, unless another installed package requires it.",
  params: [{ name: "name", prompt: "Delete package: ", collection: () => packageInstalledList(), requireMatch: true }],
  run: (name: string) => {
    deletePackage(name);
    e8.message(`Package ${name} deleted`);
  },
});
