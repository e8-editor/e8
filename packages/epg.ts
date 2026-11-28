// EasyPG, after Emacs's epg.el and epg-config.el: GnuPG run as a program,
// as Emacs runs it, the part org-crypt.el uses. A context says how gpg
// runs (protocol, armor, text mode, pinentry mode, home directory); keys
// are listed from gpg's --with-colons output; strings are encrypted to
// recipients' keys, or symmetrically with none, and decrypted. gpg talks
// back through --status-fd 1, a "[GNUPG:] KEYWORD ARGS" line at a time,
// and reads answers through --command-fd 0: a passphrase asked for with
// GET_HIDDEN is read with read-passwd, through the context's passphrase
// callback, epa-passphrase-callback-function by default as in Emacs (from
// epa.el, kept here with what calls it). gpg 2.1 and later ask for
// passphrases themselves, through the agent's pinentry, unless
// epg-pinentry-mode is loopback, as in Emacs. Signing, verifying, key
// import, export, deletion, generation and editing, and CMS (gpgsm)
// beyond its configuration, are not ported.
//
// Not loaded at startup: org-crypt.ts requires it, as Emacs autoloads it.

import { executableFind, readPasswdSync } from "subr";

e8.defineError("epg-error");

e8.defineVariable({
  name: "epg-gpg-program",
  value: executableFind("gpg2") !== undefined ? "gpg2" : "gpg",
  doc:
    'The gpg program to prefer: "gpg2" if there is one, else "gpg". Set to another program, it is used without checking ' +
    "its version, as Emacs uses one set with customize.",
});
const GPG_PROGRAM_DEFAULT = e8.variable("epg-gpg-program");

e8.defineVariable({ name: "epg-gpgsm-program", value: "gpgsm", doc: "The gpgsm program." });
e8.defineVariable({ name: "epg-gpgconf-program", value: "gpgconf", doc: "The gpgconf program." });
e8.defineVariable({
  name: "epg-gpg-home-directory",
  value: null,
  doc: "The directory holding gpg's configuration files, passed as --homedir; nil for gpg's own default.",
});
e8.defineVariable({
  name: "epg-passphrase-coding-system",
  value: null,
  doc: "The coding system passphrases are encoded in before they are sent to gpg; nil for UTF-8.",
});
e8.defineVariable({
  name: "epg-pinentry-mode",
  value: null,
  doc:
    "The pinentry mode gpg 2.1 and later are started with: nil, ask, cancel, error or loopback. With loopback gpg asks " +
    "for passphrases through E8, which reads them in the minibuffer, rather than through its own pinentry program.",
});
e8.defineVariable({ name: "epg-debug", value: null, doc: 'Whether what gpg is run with and what it says go into the buffer " *epg-debug*".' });
e8.defineVariable({ name: "epg-user-id-alist", value: [], doc: "The user ids gpg has named keys by, each a key id and a user id." });
e8.defineVariable({
  name: "epg-prompt-alist",
  value: [],
  doc: "Prompts for gpg's GET_BOOL and GET_LINE questions, each the question's keyword and the prompt to ask it with.",
});

const v = (name: string): e8.Value => e8.variable(name) ?? null;
const truthy = (x: e8.Value | undefined): boolean => x !== null && x !== undefined && x !== false;

export const EPG_GPG_MINIMUM_VERSION = "1.4.3";
export const EPG_GPG2_MINIMUM_VERSION = "2.1.6";

/** Each protocol's variable naming its program, and the programs tried with the versions each must have, as epg-config--program-alist. */
const PROGRAM_ALIST: Record<string, [string, [string, VersionRange[]][]]> = {
  OpenPGP: [
    "epg-gpg-program",
    [
      ["gpg2", [[EPG_GPG2_MINIMUM_VERSION, undefined]]],
      ["gpg", [[EPG_GPG_MINIMUM_VERSION, "2.0"], [EPG_GPG2_MINIMUM_VERSION, undefined]]],
    ],
  ],
  CMS: ["epg-gpgsm-program", [["gpgsm", [["2.0.4", undefined]]]]],
};

/** A version range, as epg-check-configuration's (MIN . MAX): at least MIN and, with MAX, below it. */
type VersionRange = [string, string | undefined];

/** What gpg says it is, as epg-config--make-gpg-configuration's alist: its program and its cfg: lines. */
export type EpgConfiguration = Map<string, unknown>;

const configurations = new Map<string, EpgConfiguration>();

/** A version's numbers, as version-to-list reads the usual ones. */
function versionList(version: string): number[] {
  return (/^[0-9]+(?:\.[0-9]+)*/.exec(version)?.[0] ?? "0").split(".").map(Number);
}

/** Whether version A comes before B, as version<. */
export function versionLessP(a: string, b: string): boolean {
  const [x, y] = [versionList(a), versionList(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? 0, y[i] ?? 0];
    if (p !== q) return p < q;
  }
  return false;
}

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

/** What a program writes to its standard output, its errors thrown away, as call-process with (t nil). */
function programOutput(program: string, args: string[]): string {
  return withTempBuffer(() => {
    e8.letBind({ "coding-system-for-read": "utf-8" }, () => e8.callProcess(program, null, [true, null], false, ...args));
    return e8.bufferText();
  });
}

/** gpg's configuration, as epg-config--make-gpg-configuration reads it from --list-config. */
function makeGpgConfiguration(program: string): EpgConfiguration {
  const config: EpgConfiguration = new Map();
  const groups: [string, string[]][] = [];
  const home = v("epg-gpg-home-directory");
  const output = programOutput(program, [...(typeof home === "string" ? ["--homedir", home] : []), "--with-colons", "--list-config"]);
  for (const m of output.matchAll(/^cfg:([^:\n]+):(.*)$/gm)) {
    const [type, args] = [m[1], m[2]];
    if (type === "group") {
      const g = /^([^:]+):/.exec(args);
      if (g) groups.unshift([g[1].toLowerCase(), args.slice(g[0].length).split(";").filter((s) => s !== "")]);
    } else if (["pubkey", "cipher", "digest", "compress"].includes(type)) {
      if (/^[0-9]+(;[0-9]+)*/.test(args)) config.set(type, args.split(";").filter((s) => s !== "").map(Number));
    } else if (!config.has(type)) config.set(type, args);
  }
  config.set("program", program);
  if (groups.length > 0) config.set("groups", groups);
  return config;
}

/** gpgsm's configuration, its program and the version --version gives, as epg-config--make-gpgsm-configuration. */
function makeGpgsmConfiguration(program: string): EpgConfiguration | undefined {
  const m = /^\S+ \([^)]*\)[ \t]*(.*)$/m.exec(programOutput(program, ["--version"]));
  return m ? new Map<string, unknown>([["program", program], ["version", m[1]]]) : undefined;
}

/** Signals unless the configuration's version is in one of the ranges, as epg-check-configuration. */
export function epgCheckConfiguration(config: EpgConfiguration, reqVersions: VersionRange[] | string = EPG_GPG_MINIMUM_VERSION): void {
  const version = config.get("version");
  if (typeof version !== "string") e8.signal("error", `Undetermined version: ${version === undefined ? "nil" : String(version)}`);
  const ranges: VersionRange[] = typeof reqVersions === "string" ? [[reqVersions, undefined]] : reqVersions;
  for (const [min, max] of ranges) {
    if (!versionLessP(version as string, min || EPG_GPG_MINIMUM_VERSION) && (max === undefined || versionLessP(version as string, max))) return;
  }
  e8.signal("error", `Unsupported version: ${version}`);
}

/**
 * A configuration to run PROTOCOL's program with, "OpenPGP" or "CMS", as
 * epg-find-configuration finds it: the one found before, unless
 * `noCache`; the program the protocol's variable names if it was set to
 * another; else the first of the programs tried that is along exec-path
 * and new enough. Undefined if there is none.
 */
export function epgFindConfiguration(protocol: string, noCache = false): EpgConfiguration | undefined {
  const entry = PROGRAM_ALIST[protocol];
  if (!entry) e8.signal("error", `Unknown protocol \`${protocol}'`);
  const [symbol, alist] = entry;
  const make = (program: string) => (protocol === "CMS" ? makeGpgsmConfiguration(program) : makeGpgConfiguration(program));
  if (!noCache && configurations.has(protocol)) return configurations.get(protocol);
  const set = v(symbol);
  if (protocol === "OpenPGP" ? set !== GPG_PROGRAM_DEFAULT && typeof set === "string" : typeof set === "string" && set !== "gpgsm") {
    const config = make(set as string);
    if (config) configurations.set(protocol, config);
    return config;
  }
  for (const [program, versions] of alist) {
    const executable = executableFind(program);
    if (executable === undefined) continue;
    const config = make(executable);
    if (config === undefined) continue;
    try {
      epgCheckConfiguration(config, versions);
    } catch {
      continue;
    }
    if (!noCache) configurations.set(protocol, config);
    return config;
  }
  return undefined;
}

/** Whether PROTOCOL's program is at least REQUIRED, as epg-required-version-p. */
export function epgRequiredVersionP(protocol: string, required: string): boolean {
  const version = epgFindConfiguration(protocol)?.get("version");
  return typeof version === "string" && !versionLessP(version, required);
}

// Keys

/** A key, as epg-key: its owner trust, its subkeys (the primary key first) and its user ids. */
export interface EpgKey {
  ownerTrust?: string;
  subKeyList: EpgSubKey[];
  userIdList: EpgUserId[];
}

/** A subkey, as epg-sub-key. */
export interface EpgSubKey {
  validity?: string;
  capability: string[];
  secretP: boolean;
  algorithm: number;
  length: number;
  id: string;
  creationTime: number;
  expirationTime?: number;
  fingerprint?: string;
}

/** A user id, as epg-user-id. */
export interface EpgUserId {
  validity?: string;
  string: string;
  signatureList: EpgKeySignature[];
}

/** A signature on a user id, as epg-key-signature. */
export interface EpgKeySignature {
  validity?: string;
  pubkeyAlgorithm: number;
  keyId: string;
  creationTime: number;
  expirationTime: number;
  userId: string;
  class: number;
  exportableP: boolean;
}

const KEY_VALIDITY: Record<string, string> = {
  o: "unknown",
  i: "invalid",
  d: "disabled",
  r: "revoked",
  e: "expired",
  "-": "none",
  q: "undefined",
  n: "never",
  m: "marginal",
  f: "full",
  u: "ultimate",
};

const KEY_CAPABILITY: Record<string, string> = { e: "encrypt", s: "sign", c: "certify", a: "authentication", D: "disabled" };

/** gpg's --with-colons lines for NAME, each split into its first 15 fields, as epg--list-keys-1. */
function listKeysLines(context: EpgContext, name: string | string[] | undefined, mode: e8.Value | undefined): (string | undefined)[][] {
  const option = mode === true || mode === "secret" ? "--list-secret-keys" : mode === undefined || mode === null || mode === "public" ? "--list-keys" : "--list-sigs";
  const args = [
    ...(context.homeDirectory ? ["--homedir", context.homeDirectory] : []),
    "--with-colons",
    "--no-greeting",
    "--batch",
    "--with-fingerprint",
    "--with-fingerprint",
    ...(context.protocol === "CMS" ? [] : ["--fixed-list-mode"]),
  ];
  if (name !== undefined && name !== null) for (const n of Array.isArray(name) ? name : [name]) args.push(option, n);
  else args.push(option);
  const lines: (string | undefined)[][] = [];
  for (const m of programOutput(context.program, args).matchAll(/^[a-z][a-z][a-z]:.*$/gm)) {
    const fields: (string | undefined)[] = [];
    const re = /([^:]+)?:/y;
    for (let r = re.exec(m[0]); r !== null && fields.length < 15; r = re.exec(m[0])) fields.push(r[1]);
    lines.push(fields);
  }
  return lines;
}

function makeSubKey(line: (string | undefined)[]): EpgSubKey {
  return {
    validity: line[1] !== undefined ? KEY_VALIDITY[line[1][0]] : undefined,
    capability: [...(line[11] ?? "")].map((c) => KEY_CAPABILITY[c]).filter((c) => c !== undefined),
    secretP: line[0] === "sec" || line[0] === "ssb",
    algorithm: e8.stringToNumber(line[3] ?? ""),
    length: e8.stringToNumber(line[2] ?? ""),
    id: line[4] ?? "",
    creationTime: e8.stringToNumber(line[5] ?? ""),
    expirationTime: line[6] !== undefined ? e8.stringToNumber(line[6]) : undefined,
  };
}

/** A user id as gpg writes it, its bytes escaped as \xNN, decoded as UTF-8, as epg-list-keys reads it. */
function decodeUserId(s: string): string {
  try {
    return s.replace(/(?:\\x[0-9a-fA-F]{2})+/g, (run) => decodeURIComponent(run.replace(/\\x/g, "%"))).replace(/\\\\/g, "\\");
  } catch {
    return s;
  }
}

/**
 * The keys matching NAME, a string or strings, as epg-list-keys: in the
 * public keyring with MODE nil or "public", the secret one with true or
 * "secret", and otherwise the public one with its signatures.
 */
export function epgListKeys(context: EpgContext, name?: string | string[], mode?: e8.Value): EpgKey[] {
  const keys: EpgKey[] = [];
  let cert = false;
  for (const line of listKeysLines(context, name, mode)) {
    const key = keys[keys.length - 1];
    const type = line[0];
    if (type === "pub" || type === "sec" || type === "crt" || type === "crs") {
      cert = type === "crt" || type === "crs";
      keys.push({ ownerTrust: line[8] !== undefined ? KEY_VALIDITY[line[8][0]] : undefined, subKeyList: [makeSubKey(line)], userIdList: [] });
    } else if (key === undefined) continue;
    else if (type === "sub" || type === "ssb") key.subKeyList.push(makeSubKey(line));
    else if (type === "uid") {
      // A certificate's distinguished name is left as gpgsm writes it, where epg-dn-from-string would parse it.
      void cert;
      key.userIdList.push({ validity: line[1] !== undefined ? KEY_VALIDITY[line[1][0]] : undefined, string: decodeUserId(line[9] ?? ""), signatureList: [] });
    } else if (type === "fpr") key.subKeyList[key.subKeyList.length - 1].fingerprint = line[9];
    else if (type === "sig") {
      key.userIdList[key.userIdList.length - 1]?.signatureList.push({
        validity: line[1] !== undefined ? KEY_VALIDITY[line[1][0]] : undefined,
        pubkeyAlgorithm: e8.stringToNumber(line[3] ?? ""),
        keyId: line[4] ?? "",
        creationTime: e8.stringToNumber(line[5] ?? ""),
        expirationTime: e8.stringToNumber(line[6] ?? ""),
        userId: line[9] ?? "",
        class: e8.stringToNumber(line[10] ?? "", 16),
        exportableP: (line[10] ?? "")[2] === "x",
      });
    }
  }
  return keys;
}

// Contexts

/** What a passphrase callback is called with: the context, the key id (or "SYM" or "PIN") and the callback's data. */
export type EpgPassphraseCallback = (context: EpgContext, keyId: string, handback?: unknown) => string | undefined;

/** An error gpg reported, as epg's (KIND . DETAIL) entries of the error result. */
export type EpgError = { kind: string; detail?: number | string; reason?: number; requested?: string };

/** The state the process filter keeps, as the epg buffer's local variables. */
interface EpgProcessState {
  partial: string;
  lines: [string, string][];
  pendingStatusList: string[] | undefined;
  lastStatus?: [string, string];
  keyId?: string;
}

/** A context, as epg-context: how gpg runs, and the operation's process and results. */
export interface EpgContext {
  protocol: string;
  program: string;
  homeDirectory: string | undefined;
  armor: boolean;
  textmode: boolean;
  includeCerts: unknown;
  cipherAlgorithm: unknown;
  digestAlgorithm: unknown;
  compressAlgorithm: unknown;
  passphraseCallback: [EpgPassphraseCallback, unknown?];
  progressCallback?: [(context: EpgContext, what: string, char: string, current: number, total: number, handback?: unknown) => void, unknown?];
  signers: EpgKey[];
  sender?: string;
  process?: e8.Process;
  state?: EpgProcessState;
  outputFile?: string;
  result: Map<string, unknown>;
  operation?: string;
  pinentryMode: string | undefined;
  errorOutput: string;
  errorBuffer?: string;
}

/** Makes a context, as epg-make-context: OpenPGP unless PROTOCOL says CMS. Signals if gpg cannot be found. */
export function epgMakeContext(
  protocol?: string | null,
  armor = false,
  textmode = false,
  includeCerts?: unknown,
  cipherAlgorithm?: unknown,
  digestAlgorithm?: unknown,
  compressAlgorithm?: unknown,
): EpgContext {
  const proto = protocol ?? "OpenPGP";
  const configuration = epgFindConfiguration(proto);
  if (!configuration) e8.signal("epg-error", `GPG error: "no usable configuration", ${proto}`, ["no usable configuration", proto]);
  const home = v("epg-gpg-home-directory");
  const pinentry = v("epg-pinentry-mode");
  return {
    protocol: proto,
    program: configuration.get("program") as string,
    homeDirectory: typeof home === "string" ? home : undefined,
    armor,
    textmode,
    includeCerts,
    cipherAlgorithm,
    digestAlgorithm,
    compressAlgorithm,
    passphraseCallback: [epaPassphraseCallbackFunction],
    signers: [],
    result: new Map(),
    pinentryMode: pinentry === null || pinentry === false ? undefined : typeof pinentry === "symbol" ? e8.symbolName(pinentry) : String(pinentry),
    errorOutput: "",
  };
}

export function epgContextResultFor(context: EpgContext, name: string): unknown {
  return context.result.get(name);
}

export function epgContextSetResultFor(context: EpgContext, name: string, value: unknown): void {
  context.result.set(name, value);
}

/** Notes an error in the context's results, as the status functions push them onto its error list. */
function pushError(context: EpgContext, error: EpgError): void {
  epgContextSetResultFor(context, "error", [...((epgContextResultFor(context, "error") as EpgError[] | undefined) ?? []), error]);
}

/** Sets the function asked for passphrases, and the data it is given, as epg-context-set-passphrase-callback. */
export function epgContextSetPassphraseCallback(context: EpgContext, callback: EpgPassphraseCallback, handback?: unknown): void {
  context.passphraseCallback = [callback, handback];
}

/** Sets the function told of gpg's progress, as epg-context-set-progress-callback. */
export function epgContextSetProgressCallback(context: EpgContext, callback: NonNullable<EpgContext["progressCallback"]>[0], handback?: unknown): void {
  context.progressCallback = [callback, handback];
}

const INVALID_RECIPIENTS_REASONS: Record<number, string> = {
  0: "No specific reason given",
  1: "Not Found",
  2: "Ambiguous specification",
  3: "Wrong key usage",
  4: "Key revoked",
  5: "Key expired",
  6: "No CRL known",
  7: "CRL too old",
  8: "Policy mismatch",
  9: "Not a secret key",
  10: "Key not trusted",
};

const NO_DATA_REASONS: Record<number, string> = {
  1: "No armored data",
  2: "Expected a packet but did not find one",
  3: "Invalid packet found, this may indicate a non OpenPGP message",
  4: "Signature expected but not found",
};

/** An error as words, as epg-error-to-string. */
export function epgErrorToString(error: EpgError): string {
  switch (error.kind) {
    case "exit":
      return "Exit";
    case "quit":
      return "Canceled";
    case "no-data": {
      const reason = NO_DATA_REASONS[error.detail as number];
      return reason ? `No data (${reason.toLowerCase()})` : "No data";
    }
    case "unexpected":
      return "Unexpected";
    case "bad-armor":
      return "Bad armor";
    case "invalid-recipient":
    case "invalid-signer": {
      const reason = error.reason !== undefined && error.reason > 0 ? INVALID_RECIPIENTS_REASONS[error.reason] : undefined;
      return (
        (error.kind === "invalid-recipient" ? "Unusable public key" : "Unusable secret key") +
        (error.requested !== undefined ? `: ${error.requested}` : ": <unknown>") +
        (reason ? ` (${reason.toLowerCase()})` : "")
      );
    }
    case "no-pubkey":
      return `No public key: ${error.detail}`;
    case "no-seckey":
      return `No secret key: ${error.detail}`;
    case "no-recipients":
      return "No recipients";
    case "no-signers":
      return "No signers";
    default:
      return "";
  }
}

export function epgErrorsToString(errors: EpgError[] | undefined): string {
  return (errors ?? []).map(epgErrorToString).join("; ");
}

/** Signals epg-error with Emacs's message for its data, as (signal 'epg-error (list WHAT DETAIL)). */
function signalEpgError(what: string, detail: string): never {
  e8.signal("epg-error", `GPG error: ${JSON.stringify(what)}, ${JSON.stringify(detail)}`, [what, detail]);
}

/** The terminal E8 runs on, as epg--start asks tty, if it is on one. */
function terminalName(): string | undefined {
  return withTempBuffer(() => {
    try {
      if (e8.callProcess("tty", "/dev/fd/0", true) !== 0) return undefined;
      const text = e8.bufferText();
      return text.endsWith("\n") ? text.slice(0, -1) : text;
    } catch (e) {
      if (e8.errorConditions(e).includes("file-error")) return undefined;
      throw e;
    }
  });
}

/** Appends to the " *epg-debug*" buffer, as epg does with epg-debug set. */
function debug(text: string): void {
  if (!truthy(v("epg-debug"))) return;
  e8.withCurrentBuffer(e8.getBufferCreate(" *epg-debug*"), () => {
    e8.gotoChar(e8.pointMax());
    e8.insert(text);
  });
}

/** Starts gpg with ARGS after the options every operation passes, as epg--start. */
function start(context: EpgContext, args: string[]): void {
  if (context.process && e8.processStatus(context.process) === "run") e8.signal("error", `${context.program} is already running in this context`);
  const agentInfo = e8.getenv("GPG_AGENT_INFO");
  const all = [
    "--no-tty",
    "--status-fd",
    "1",
    "--yes",
    ...(context.protocol !== "CMS" && (agentInfo ?? "").includes(":") ? ["--use-agent"] : []),
    ...(context.protocol !== "CMS" && context.progressCallback ? ["--enable-progress-filter"] : []),
    ...(context.homeDirectory ? ["--homedir", context.homeDirectory] : []),
    ...(context.protocol !== "CMS" ? ["--command-fd", "0"] : []),
    ...(context.armor ? ["--armor"] : []),
    ...(context.textmode ? ["--textmode"] : []),
    ...(context.outputFile ? ["--output", context.outputFile] : []),
    // Loopback does not work with gpgsm.
    ...(context.pinentryMode && !(context.protocol === "CMS" && context.pinentryMode === "loopback") ? ["--pinentry-mode", context.pinentryMode] : []),
    ...args,
  ];
  const env: { [name: string]: string } = {};
  const tty = terminalName();
  if (tty !== undefined) {
    // For pinentry-curses.
    env.GPG_TTY = tty;
    env.TERM = "xterm";
  }
  env.INSIDE_EMACS = "e8,epg";
  debug((agentInfo !== undefined ? `GPG_AGENT_INFO=${agentInfo}\n` : "GPG_AGENT_INFO is not set\n") + `${context.program} ${all.join(" ")}\n`);
  const state: EpgProcessState = { partial: "", lines: [], pendingStatusList: undefined };
  const errorBuffer = e8.generateNewBufferName(" *epg-error*");
  e8.getBufferCreate(errorBuffer);
  context.errorBuffer = errorBuffer;
  const buffer = e8.generateNewBufferName(" *epg*");
  e8.getBufferCreate(buffer);
  const process = e8.makeProcess({
    name: "epg",
    buffer,
    command: [context.program, ...all],
    env,
    connectionType: "pipe",
    // gpg's status lines, and what is sent to it, as UTF-8, as Emacs's raw-text sends its strings.
    coding: "utf-8-unix",
    filter: (_process: e8.Process, input: string) => processFilter(state, input),
    stderr: errorBuffer,
  });
  e8.setProcessQueryOnExitFlag(process, false);
  context.process = process;
  context.state = state;
}

/** Takes gpg's output a line at a time, its status lines kept to be handled, as epg--process-filter reads them. */
function processFilter(state: EpgProcessState, input: string): void {
  debug(input);
  const text = state.partial + input;
  const lines = text.split("\n");
  state.partial = lines.pop()!;
  for (const line of lines) {
    const m = /^\[GNUPG:\] ([A-Z_]+) ?(.*)/.exec(line);
    if (m) state.lines.push([m[1], m[2]]);
  }
}

/**
 * Handles the status lines that have come, as epg--process-filter calls
 * epg--status-KEYWORD for each. Done outside the filter, as the waiting
 * loops call it, so that a passphrase can be read in the minibuffer.
 */
function handleStatus(context: EpgContext): void {
  const state = context.state!;
  while (state.lines.length > 0) {
    const [status, string] = state.lines.shift()!;
    if (state.pendingStatusList?.includes(status)) state.pendingStatusList = undefined;
    STATUS[status]?.(context, string);
    state.lastStatus = [status, string];
  }
}

/** Waits until one of STATUSES has come, or gpg has ended, as epg-wait-for-status. */
function waitForStatus(context: EpgContext, statuses: string[]): void {
  const state = context.state!;
  state.pendingStatusList = statuses;
  handleStatus(context);
  while (e8.processStatus(context.process!) === "run" && state.pendingStatusList !== undefined) {
    e8.acceptProcessOutput(context.process, 1);
    handleStatus(context);
  }
  if (state.pendingStatusList !== undefined) {
    drain(context);
    if (state.pendingStatusList !== undefined) pushError(context, { kind: "exit" });
  }
}

/** Takes what gpg wrote before it ended, as epg-wait-for-completion's sleep-for lets the filter run. */
function drain(context: EpgContext): void {
  while (e8.acceptProcessOutput(context.process, 0.05)) {}
  handleStatus(context);
}

/** Waits until gpg has ended, as epg-wait-for-completion, then keeps what it wrote to standard error. */
export function epgWaitForCompletion(context: EpgContext): void {
  while (e8.processStatus(context.process!) === "run") {
    e8.acceptProcessOutput(context.process, 1);
    handleStatus(context);
  }
  drain(context);
  context.errorOutput = context.errorBuffer && e8.bufferLiveP(e8.getBuffer(context.errorBuffer)) ? e8.withCurrentBuffer(context.errorBuffer, () => e8.bufferText()) : "";
}

/** Kills the operation's buffers, as epg-reset. */
export function epgReset(context: EpgContext): void {
  const buffer = context.process ? e8.processBuffer(context.process) : undefined;
  if (buffer !== undefined && e8.getBuffer(buffer)) e8.call("kill-buffer", buffer);
  if (context.errorBuffer !== undefined && e8.getBuffer(context.errorBuffer)) e8.call("kill-buffer", context.errorBuffer);
  context.process = undefined;
  context.state = undefined;
}

/** What gpg wrote to the output file, decoded as UTF-8, as epg-read-output reads it. */
function readOutput(context: EpgContext): string | undefined {
  const file = context.outputFile;
  if (file === undefined || !e8.fileExistsP(file)) return undefined;
  return withTempBuffer(() => {
    e8.letBind({ "coding-system-for-read": "utf-8" }, () => e8.insertFileContents(file));
    return e8.bufferText();
  });
}

function deleteOutputFile(context: EpgContext): void {
  if (context.outputFile !== undefined && e8.fileExistsP(context.outputFile)) e8.deleteFile(context.outputFile);
}

/** Sends a string to gpg while it runs. */
function send(context: EpgContext, text: string): void {
  if (e8.processStatus(context.process!) === "run") e8.processSendString(context.process!, text);
}

// Status lines, as epg--status-KEYWORD.

/** Asks the context's callback for a passphrase and sends it, as epg--status-GET_HIDDEN. */
function getHidden(context: EpgContext, string: string): void {
  const state = context.state!;
  if (state.keyId === undefined || !string.startsWith("passphrase.")) return;
  const [callback, handback] = context.passphraseCallback;
  if (!callback) e8.signal("error", "Variable `passphrase-callback' not set");
  e8.conditionCase(
    () => {
      const passphrase = callback(context, state.keyId!, handback);
      if (passphrase !== undefined && passphrase !== null) send(context, passphrase + "\n");
    },
    {
      quit: () => {
        pushError(context, { kind: "quit" });
        e8.deleteProcess(context.process!);
      },
    },
  );
}

/** Asks a yes or no question and sends the answer, as epg--status-GET_BOOL. */
function getBool(context: EpgContext, string: string): void {
  const prompts = v("epg-prompt-alist");
  e8.conditionCase(
    () => {
      let question: string;
      const last = context.state!.lastStatus;
      if (string === "untrusted_key.override") {
        const m = last?.[0] === "USERID_HINT" ? /^([^ ]+) (.*)/.exec(last[1]) : null;
        question = m ? `Untrusted key ${m[1]} ${userIdFor(m[1]) ?? m[2]}.  Use anyway? ` : "Use untrusted key anyway? ";
      } else question = promptFor(prompts, string) ?? `${string}? `;
      send(context, e8.yOrNP(question) ? "y\n" : "n\n");
    },
    {
      quit: () => {
        pushError(context, { kind: "quit" });
        e8.deleteProcess(context.process!);
      },
    },
  );
}

/** Reads a line and sends it, as epg--status-GET_LINE. */
function getLine(context: EpgContext, string: string): void {
  e8.conditionCase(() => send(context, e8.readString(promptFor(v("epg-prompt-alist"), string) ?? `${string}: `) + "\n"), {
    quit: () => {
      pushError(context, { kind: "quit" });
      e8.deleteProcess(context.process!);
    },
  });
}

function promptFor(alist: e8.Value, key: string): string | undefined {
  if (!Array.isArray(alist)) return undefined;
  for (const entry of alist) if (Array.isArray(entry) && entry[0] === key && typeof entry[1] === "string") return entry[1];
  return undefined;
}

function userIdFor(keyId: string): string | undefined {
  const alist = v("epg-user-id-alist");
  if (!Array.isArray(alist)) return undefined;
  for (const entry of alist) if (Array.isArray(entry) && entry[0] === keyId) return String(entry[1]);
  return undefined;
}

/** A string's %XX escapes decoded as UTF-8, as rfc6068-unhexify-string. */
function unhexify(s: string): string {
  try {
    return decodeURIComponent(s.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
  } catch {
    return s;
  }
}

const STATUS: Record<string, (context: EpgContext, string: string) => void> = {
  USERID_HINT: (_context, string) => {
    const m = /^([^ ]+) (.*)/.exec(string);
    if (!m) return;
    const [keyId, userId] = [m[1], unhexify(m[2])];
    const alist = v("epg-user-id-alist");
    const list = Array.isArray(alist) ? (alist as e8.Value[][]).filter((e) => !(Array.isArray(e) && e[0] === keyId)) : [];
    e8.setVariable("epg-user-id-alist", [[keyId, userId], ...list]);
  },
  NEED_PASSPHRASE: (context, string) => {
    const m = /^([^ ]+)/.exec(string);
    if (m) context.state!.keyId = m[1];
  },
  NEED_PASSPHRASE_SYM: (context) => {
    context.state!.keyId = "SYM";
  },
  NEED_PASSPHRASE_PIN: (context) => {
    context.state!.keyId = "PIN";
  },
  GET_HIDDEN: getHidden,
  GET_BOOL: getBool,
  GET_LINE: getLine,
  PROGRESS: (context, string) => {
    const m = /^([^ ]+) ([^ ]) ([0-9]+) ([0-9]+)/.exec(string);
    if (context.progressCallback && m) context.progressCallback[0](context, m[1], m[2], Number(m[3]), Number(m[4]), context.progressCallback[1]);
  },
  ENC_TO: (context, string) => {
    const m = /^([0-9A-Za-z]+) ([0-9]+) ([0-9]+)/.exec(string);
    if (m) epgContextSetResultFor(context, "encrypted-to", [[m[1], Number(m[2]), Number(m[3])], ...((epgContextResultFor(context, "encrypted-to") as unknown[]) ?? [])]);
  },
  DECRYPTION_FAILED: (context) => epgContextSetResultFor(context, "decryption-failed", true),
  DECRYPTION_OKAY: (context) => epgContextSetResultFor(context, "decryption-okay", true),
  NODATA: (context, string) => pushError(context, { kind: "no-data", detail: e8.stringToNumber(string) }),
  UNEXPECTED: (context, string) => pushError(context, { kind: "unexpected", detail: e8.stringToNumber(string) }),
  KEYEXPIRED: (context, string) =>
    epgContextSetResultFor(context, "key", [{ kind: "key-expired", expirationTime: e8.stringToNumber(string) }, ...((epgContextResultFor(context, "key") as unknown[]) ?? [])]),
  KEYREVOKED: (context) => epgContextSetResultFor(context, "key", [{ kind: "key-revoked" }, ...((epgContextResultFor(context, "key") as unknown[]) ?? [])]),
  BADARMOR: (context) => pushError(context, { kind: "bad-armor" }),
  INV_RECP: (context, string) => {
    const m = /^([0-9]+) (.*)/.exec(string);
    if (m) pushError(context, { kind: "invalid-recipient", reason: Number(m[1]), requested: m[2] });
  },
  INV_SGNR: (context, string) => {
    const m = /^([0-9]+) (.*)/.exec(string);
    if (m) pushError(context, { kind: "invalid-signer", reason: Number(m[1]), requested: m[2] });
  },
  NO_RECP: (context) => pushError(context, { kind: "no-recipients" }),
  NO_SGNR: (context) => pushError(context, { kind: "no-signers" }),
  NO_PUBKEY: (context, string) => pushError(context, { kind: "no-pubkey", detail: string }),
  NO_SECKEY: (context, string) => pushError(context, { kind: "no-seckey", detail: string }),
};

// Operations

/** A temporary file's name, made, as make-temp-file. */
function tempFile(prefix: string): string {
  return e8.makeTempFile(prefix);
}

/** Starts decrypting the file CIPHER, as epg-start-decrypt, and waits until gpg begins. */
export function epgStartDecrypt(context: EpgContext, cipher: string): void {
  context.operation = "decrypt";
  context.result = new Map();
  start(context, ["--decrypt", "--", cipher]);
  // gpgsm does not read a passphrase from its input, so is not waited for.
  if (context.protocol !== "CMS") waitForStatus(context, ["BEGIN_DECRYPTION"]);
}

function checkErrorForDecrypt(context: EpgContext): void {
  const errors = epgContextResultFor(context, "error") as EpgError[] | undefined;
  if (epgContextResultFor(context, "decryption-failed")) signalEpgError("Decryption failed", epgErrorsToString(errors));
  if (!epgContextResultFor(context, "decryption-okay")) signalEpgError("Can't decrypt", epgErrorsToString(errors));
}

/**
 * Decrypts a string and returns the plain text, as epg-decrypt-string.
 * The text comes back decoded as UTF-8, where Emacs's is bytes its caller
 * decodes.
 */
export function epgDecryptString(context: EpgContext, cipher: string): string {
  const input = tempFile("epg-input");
  try {
    e8.letBind({ "coding-system-for-write": "utf-8-unix" }, () => e8.writeRegion(cipher, null, input, { quiet: true }));
    context.outputFile = tempFile("epg-output");
    epgStartDecrypt(context, input);
    epgWaitForCompletion(context);
    checkErrorForDecrypt(context);
    return readOutput(context) ?? "";
  } finally {
    deleteOutputFile(context);
    if (e8.fileExistsP(input)) e8.deleteFile(input);
    epgReset(context);
  }
}

/**
 * Starts encrypting PLAIN, the text itself or { file }, to RECIPIENTS, or
 * symmetrically with none, as epg-start-encrypt: waits until gpg begins,
 * then sends text given as a string.
 */
export function epgStartEncrypt(context: EpgContext, plain: string | { file: string }, recipients: EpgKey[] | undefined, sign = false, alwaysTrust = false): void {
  context.operation = "encrypt";
  context.result = new Map();
  const args = [
    ...(alwaysTrust ? ["--always-trust"] : []),
    ...(recipients && recipients.length > 0 ? ["--encrypt"] : ["--symmetric"]),
    ...(sign ? ["--sign"] : []),
    ...(sign ? context.signers.flatMap((signer) => ["-u", signer.subKeyList[0].id]) : []),
    ...(sign && context.protocol === "OpenPGP" && typeof context.sender === "string" && epgRequiredVersionP("OpenPGP", "2.1.15") ? ["--sender", context.sender] : []),
    ...(recipients ?? []).flatMap((recipient) => ["-r", recipient.subKeyList[0].id]),
    ...(typeof plain === "object" ? ["--", plain.file] : []),
  ];
  start(context, args);
  if (context.protocol !== "CMS") waitForStatus(context, sign ? ["BEGIN_SIGNING"] : ["BEGIN_ENCRYPTION"]);
  if (typeof plain === "string") {
    send(context, plain);
    if (e8.processStatus(context.process!) === "run") e8.processSendEof(context.process!);
  }
}

/** Encrypts a string to RECIPIENTS, or symmetrically with none, and returns what gpg wrote, as epg-encrypt-string. */
export function epgEncryptString(context: EpgContext, plain: string, recipients: EpgKey[] | undefined, sign = false, alwaysTrust = false): string {
  const input = sign && context.protocol !== "CMS" ? tempFile("epg-input") : undefined;
  try {
    context.outputFile = tempFile("epg-output");
    if (input !== undefined) e8.letBind({ "coding-system-for-write": "utf-8-unix" }, () => e8.writeRegion(plain, null, input, { quiet: true }));
    epgStartEncrypt(context, input !== undefined ? { file: input } : plain, recipients, sign, alwaysTrust);
    epgWaitForCompletion(context);
    const errors = epgContextResultFor(context, "error") as EpgError[] | undefined;
    if (sign && !epgContextResultFor(context, "sign")) signalEpgError("Sign failed", epgErrorsToString(errors));
    if (errors && errors.length > 0) signalEpgError("Encrypt failed", epgErrorsToString(errors));
    return readOutput(context) ?? "";
  } finally {
    deleteOutputFile(context);
    if (input !== undefined && e8.fileExistsP(input)) e8.deleteFile(input);
    epgReset(context);
  }
}

// From epa.el.

/**
 * Reads a passphrase for a key, or for symmetric encryption, as
 * epa-passphrase-callback-function: twice when encrypting, to confirm it.
 */
export function epaPassphraseCallbackFunction(context: EpgContext, keyId: string, handback?: unknown): string {
  if (keyId === "SYM") {
    return readPasswdSync(`Passphrase for symmetric encryption${typeof handback === "string" ? ` for ${handback}` : ""}: `, context.operation === "encrypt");
  }
  if (keyId === "PIN") return readPasswdSync("Passphrase for PIN: ");
  const user = userIdFor(keyId);
  return readPasswdSync(user !== undefined ? `Passphrase for ${keyId} ${user}: ` : `Passphrase for ${keyId}: `);
}
