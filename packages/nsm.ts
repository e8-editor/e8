// The Network Security Manager, after Emacs's nsm.el: before a TLS
// connection is used, what verifying its peer found wrong, and whether
// its key is the one seen before, are put to the user, who accepts the
// certificate always, for the session, or not at all, which closes the
// connection. With no user to ask, as in batch mode, the answer is no.
//
// Of nsm.el's checks, E8 makes the two its TLS can fail: the certificate
// (verify-cert) and a pinned key (same-cert). The others look for ciphers,
// key exchanges and protocols rustls never offers (RC4, 3DES, CBC, SHA-1
// and MD5 signatures, SSL 3, export and anonymous suites). Emacs keeps
// what was accepted for good as Lisp in network-security.data; E8 keeps it
// as JSON in network-security.json, beside init.ts.

import { eraseBuffer, truthy } from "subr";

e8.defineVariable({
  name: "network-security-level",
  doc: "How hard network connections are checked: low checks nothing, medium (the default) asks about certificates that do not verify or whose key changed, high and paranoid as medium in E8, paranoid also asking about each certificate not seen before.",
  value: "medium",
});
e8.defineVariable({
  name: "nsm-noninteractive",
  doc: "Whether there is no user to ask, so a connection with a problem is refused, as in batch mode.",
  value: false,
});
e8.defineVariable({
  name: "nsm-settings-file",
  doc: "Where certificates accepted for good are kept: network-security.json in user-emacs-directory if nil.",
  value: null,
});
e8.defineVariable({
  name: "nsm-temporary-host-settings",
  doc: "What was accepted this session, host by host.",
  value: [],
});
e8.defineVariable({
  name: "nsm-permanent-host-settings",
  doc: "What was accepted for good, as read from nsm-settings-file.",
  value: [],
});

/** What is remembered of a host: its id, the keys accepted, and the problems accepted. */
interface HostSettings {
  id: string;
  fingerprints: string[];
  conditions: string[];
}

/** How strict a level is, as nsm-level: anything it does not know counts as high. */
const level = (name: unknown): number => (name === "low" ? 0 : name === "medium" ? 1 : 2);

/** Whether the checks of this level run, as network-security-protocol-checks lists each with its own. */
const checksAt = (wanted: "medium" | "high"): boolean => level(e8.variable("network-security-level")) >= level(wanted);

function settingsFile(): string | undefined {
  const own = e8.variable("nsm-settings-file");
  if (typeof own === "string") return e8.expandFileName(own);
  const dir = e8.variable("user-emacs-directory");
  return typeof dir === "string" ? e8.expandFileName("network-security.json", dir) : undefined;
}

let read = false;

function permanent(): HostSettings[] {
  if (!read) {
    read = true;
    const file = settingsFile();
    if (file !== undefined && e8.fileExistsP(file)) {
      try {
        const list = JSON.parse(e8.readTextFile(file));
        if (Array.isArray(list)) e8.setVariable("nsm-permanent-host-settings", list);
      } catch {
        // A file that does not read is as none.
      }
    }
  }
  const list = e8.variable("nsm-permanent-host-settings");
  return Array.isArray(list) ? (list as unknown as HostSettings[]) : [];
}

const temporary = (): HostSettings[] => {
  const list = e8.variable("nsm-temporary-host-settings");
  return Array.isArray(list) ? (list as unknown as HostSettings[]) : [];
};

/** A host and port as nsm.el keys them: "sha1:" and the hash of "host:port". */
export function nsmId(host: string, port: number | string): string {
  return `sha1:${e8.secureHash("sha1", `${host}:${port}`)}`;
}

/** What is remembered of a host, this session's first, as nsm-host-settings. */
export function nsmHostSettings(id: string): HostSettings | undefined {
  return temporary().find((s) => s.id === id) ?? permanent().find((s) => s.id === id);
}

const fingerprint = (status: e8.GnutlsPeerStatus): string | undefined => status.certificate?.publicKeyId;

function fingerprintOk(status: e8.GnutlsPeerStatus, settings: HostSettings | undefined): boolean {
  const saved = settings?.fingerprints ?? [];
  const key = fingerprint(status);
  return saved.length === 0 || saved.includes(":none") || (key !== undefined && saved.includes(key));
}

function warningsOk(status: e8.GnutlsPeerStatus, settings: HostSettings | undefined): boolean {
  const conditions = settings?.conditions ?? [];
  return (status.warnings ?? []).every((w) => conditions.includes(`:${w}`));
}

/**
 * Remembers that a host was accepted, for the session or for good, as
 * nsm-save-host: `what` is "conditions", the problems accepted, or
 * "fingerprint", the key seen, which keeps the conditions already saved.
 * The key seen joins those already known, as Emacs's does.
 */
function saveHost(host: string, port: number | string, status: e8.GnutlsPeerStatus | undefined, what: "conditions" | "fingerprint", problems: string[], permanency: "session" | "always"): void {
  const id = nsmId(host, port);
  const old = nsmHostSettings(id);
  const key = (status && fingerprint(status)) ?? ":none";
  const fingerprints = [...new Set([...(old?.fingerprints ?? []), key])];
  const conditions = what === "conditions" ? problems : [...new Set([...(old?.conditions ?? []), ...problems])];
  const entry: HostSettings = { id, fingerprints, conditions };
  // Saved for good, it is no longer the session's, as nsm-save-host
  // removes the temporary setting either way.
  e8.setVariable("nsm-temporary-host-settings", temporary().filter((s) => s.id !== id) as unknown as e8.Value);
  if (permanency === "always") {
    e8.setVariable("nsm-permanent-host-settings", [...permanent().filter((s) => s.id !== id), entry] as unknown as e8.Value);
    const file = settingsFile();
    if (file !== undefined) e8.writeTextFile(file, `${JSON.stringify(permanent(), null, 2)}\n`);
  } else {
    e8.setVariable("nsm-temporary-host-settings", [...temporary(), entry] as unknown as e8.Value);
  }
}

/**
 * Asks whether to go on with a connection that has problems, as nsm-query:
 * the reasons and the certificate in *Network Security Manager*, then
 * always, session only or no. No when there is no user to ask, or on C-g.
 */
function query(host: string, port: number | string, status: e8.GnutlsPeerStatus | undefined, problems: string[], message: string): boolean {
  if (truthy(e8.variable("noninteractive")) || truthy(e8.variable("nsm-noninteractive"))) {
    e8.message(`Aborting connection to ${host}:${port}`);
    return false;
  }
  const details = status?.certificate ? `\n\nCertificate:\n\n${e8.gnutlsFormatCertificate(status.certificate.pem)}` : "";
  const buffer = e8.getBufferCreate("*Network Security Manager*");
  e8.withCurrentBuffer(buffer, () => {
    eraseBuffer();
    e8.insert(`${message}${details}`);
    e8.gotoChar(0);
  });
  let answer: string;
  try {
    answer = e8.saveWindowExcursion(() => {
      e8.call("display-buffer", "*Network Security Manager*");
      return e8.readAnswer("Continue connecting? ", ["always", "session", "no"]);
    });
  } catch {
    answer = "no";
  }
  if (answer !== "always" && answer !== "session") {
    e8.message(`Aborting connection to ${host}:${port}`);
    return false;
  }
  e8.message(answer === "session" ? `Accepting certificate for ${host}:${port} this session only` : `Permanently accepting certificate for ${host}:${port}`);
  saveHost(host, port, status, "conditions", problems, answer);
  return true;
}

/**
 * Checks a connection to `host` and `port` before it is used, as
 * nsm-verify-connection: returns the process, or deletes it and returns
 * undefined when the user will not have it. With `saveFingerprint`, a
 * TLS peer's key is remembered for next time; with `warnUnencrypted`, a
 * connection without TLS is asked about.
 */
export function nsmVerifyConnection(process: e8.Process, host: string, port: number | string, saveFingerprint = false, warnUnencrypted = false): e8.Process | undefined {
  if (!e8.processLiveP(process)) return undefined;
  const id = nsmId(host, port);
  const settings = nsmHostSettings(id);
  const status = e8.gnutlsPeerStatus(process);
  // At "low" nothing is checked, as the checks below are medium's.
  if (!checksAt("medium")) return process;
  if (status === undefined) {
    // Once encrypted and now not may be someone stripping STARTTLS out.
    const fingerprints = settings?.fingerprints ?? [];
    const wasEncrypted = fingerprints.length > 0 && !fingerprints.includes(":none");
    const ask =
      (wasEncrypted && `The connection to ${host}:${port} used to be an encrypted connection, but is now unencrypted.  This might mean that there's a man-in-the-middle tapping this connection.`) ||
      (warnUnencrypted && !(settings?.conditions ?? []).includes(":unencrypted") && `The connection to ${host}:${port} is unencrypted.`);
    if (ask && !query(host, port, undefined, [":unencrypted"], ask)) {
      e8.deleteProcess(process);
      return undefined;
    }
    return process;
  }
  const results: [string, string][] = [];
  if (status.warnings?.length && !warningsOk(status, settings)) {
    results.push([":verify-cert", status.warnings.map((w) => e8.gnutlsPeerStatusWarningDescribe(w) ?? w).join("\n")]);
  }
  if (!fingerprintOk(status, settings)) results.push([":same-cert", "fingerprint has changed"]);
  if (e8.variable("network-security-level") === "paranoid" && !fingerprintOk(status, settings)) {
    results.push([":not-seen", "Certificate not seen before"]);
  }
  const problems = [...(status.warnings ?? []).map((w) => `:${w}`), ...results.map(([type]) => type)];
  if (results.length > 0) {
    const reasons = results.map(([, text]) => text).join("\n").split("\n").join("\n* ");
    const message = `The TLS connection to ${host}:${port} is insecure\nfor the following reason${problems.length > 1 ? "s" : ""}:\n\n* ${reasons}`;
    if (!query(host, port, status, problems, message)) {
      e8.deleteProcess(process);
      return undefined;
    }
  }
  if (saveFingerprint && nsmHostSettings(id) === undefined) saveHost(host, port, status, "fingerprint", [], "always");
  return process;
}

e8.defun("nsm-verify-connection", (process: e8.Process, host: string, port: number | string, save?: boolean, warn?: boolean) =>
  nsmVerifyConnection(process, host, port, truthy(save), truthy(warn)) ?? null);
