// TLS connections, after Emacs's gnutls.el: gnutls-negotiate starts TLS
// on a network process with gnutls-boot, taking the trust files, what
// verifying must refuse and the rest from the variables below, and
// open-gnutls-stream opens a connection with it. E8's TLS is rustls, not
// GnuTLS, under GnuTLS's names: it has no priority strings, CRLs, minimum
// prime bits or anonymous credentials, so those are taken and set aside.

e8.defineVariable({
  name: "gnutls-algorithm-priority",
  doc: "GnuTLS's priority string for TLS connections. E8's TLS has none, so this is kept but not used.",
  value: null,
});
e8.defineVariable({
  name: "gnutls-verify-error",
  doc: "Which failures to verify a TLS peer refuse the connection: t for all, or a list of (HOST-REGEXP CHECKS), CHECKS being t or a list of :trustfiles and :hostname. Nil refuses none, leaving the Network Security Manager to ask.",
  value: null,
});
e8.defineVariable({
  name: "gnutls-trustfiles",
  doc: "Files of authorities to trust as well as the system's, those that do not exist left out: as in Emacs, where each system keeps its bundle.",
  value: [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/usr/ssl/certs/ca-bundle.crt",
    "/usr/local/share/certs/ca-root-nss.crt",
    "/etc/ssl/cert.pem",
    "/etc/certs/ca-certificates.crt",
  ],
});
e8.defineVariable({
  name: "gnutls-min-prime-bits",
  doc: "The fewest bits of a Diffie-Hellman prime to accept. E8's TLS uses only elliptic curves, so this is kept but not used.",
  value: null,
});
e8.defineVariable({
  name: "gnutls-crlfiles",
  doc: "Files of revoked certificates. E8's TLS reads none, so this is kept but not used.",
  value: ["/etc/grid-security/certificates/*.crl.pem"],
});
e8.defineVariable({
  name: "gnutls-log-level",
  doc: "How much GnuTLS logs. E8's TLS logs nothing, so this is kept but not used.",
  value: 0,
});

/** What gnutlsNegotiate and gnutlsBootParameters take, as gnutls.el's keywords. */
export interface GnutlsSpec {
  process?: e8.Process;
  type?: "gnutls-x509pki" | "gnutls-anon";
  hostname: string;
  priorityString?: string;
  trustfiles?: string[];
  crlfiles?: string[];
  keylist?: [string, string][];
  minPrimeBits?: number;
  verifyFlags?: number;
  verifyError?: true | string[] | null;
  verifyHostnameError?: boolean;
}

/** The trust files there are, as gnutls-trustfiles: gnutls-trustfiles's that exist. Emacs also expands globs, for Android's directories of certificates; E8 takes files only. */
export function gnutlsTrustfiles(): string[] {
  const value = e8.variable("gnutls-trustfiles") as unknown;
  const files = typeof value === "function" ? (value as () => unknown)() : value;
  if (!Array.isArray(files)) return [];
  return files.filter((f): f is string => typeof f === "string" && !f.includes("*") && e8.fileExistsP(f));
}

/** What verifying must refuse for `hostname`, as gnutls-verify-error says. */
function verifyErrorFor(hostname: string): true | string[] | null {
  const setting = e8.variable("gnutls-verify-error") as unknown;
  if (setting === true) return true;
  if (!Array.isArray(setting)) return null;
  for (const entry of setting) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && e8.stringMatch(entry[0], hostname) !== undefined) {
      const checks = entry[1];
      return checks === true ? true : Array.isArray(checks) ? checks.map(String) : null;
    }
  }
  return null;
}

/** The parameters gnutlsBoot takes, as gnutls-boot-parameters works them out. */
export function gnutlsBootParameters(spec: GnutlsSpec): { hostname: string; trustfiles: string[]; keylist: [string, string][]; verifyError?: true | string[] } {
  let verifyError = spec.verifyError ?? verifyErrorFor(spec.hostname);
  // :hostname added only when verify-error is not t, which has it (Bug#38602).
  if (spec.verifyHostnameError && verifyError !== true) verifyError = [...(verifyError ?? []), ":hostname"];
  const params: { hostname: string; trustfiles: string[]; keylist: [string, string][]; verifyError?: true | string[] } = {
    hostname: spec.hostname,
    trustfiles: spec.trustfiles ?? gnutlsTrustfiles(),
    keylist: spec.keylist ?? [],
  };
  if (verifyError) params.verifyError = verifyError === true ? true : verifyError.map((c) => c.replace(/^:/, ""));
  return params;
}

/** Starts TLS on a process, as gnutls-negotiate: returns it, or signals gnutls-error. */
export function gnutlsNegotiate(spec: GnutlsSpec): e8.Process {
  if (spec.process === undefined) throw new Error("gnutls-negotiate needs a process");
  e8.gnutlsBoot(spec.process, spec.type ?? "gnutls-x509pki", gnutlsBootParameters(spec) as Parameters<typeof e8.gnutlsBoot>[2]);
  return spec.process;
}

/**
 * Opens a TLS connection to `host` and `service`, as open-gnutls-stream:
 * a network process, its output into `buffer` unless it has a filter.
 * `parameters` may give a client certificate, as a key and certificate
 * file, and the coding.
 */
export function openGnutlsStream(name: string, buffer: e8.BufferLike | null, host: string, service: number | string, parameters: { clientCertificate?: [string, string] | null; coding?: string | [string, string] } = {}): e8.Process {
  const process = e8.makeNetworkProcess({ name, buffer: buffer ?? undefined, host, service, coding: parameters.coding });
  try {
    return gnutlsNegotiate({ process, type: "gnutls-x509pki", hostname: host, keylist: parameters.clientCertificate ? [parameters.clientCertificate] : undefined });
  } catch (e) {
    e8.deleteProcess(process);
    throw e;
  }
}

e8.defun("gnutls-trustfiles", () => gnutlsTrustfiles());
