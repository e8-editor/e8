// Network connections with or without TLS, after Emacs's
// network-stream.el: open-network-stream opens a plain connection, or a
// TLS one through gnutls.ts that the Network Security Manager has checked.
// STARTTLS (:type starttls, or network with :capability-command and
// :success) and connections through a shell command are not in E8 yet.

import { openGnutlsStream } from "gnutls";
import { nsmVerifyConnection } from "nsm";

/** What openNetworkStream takes, as open-network-stream's keywords. */
export interface NetworkStreamParameters {
  /** "plain" or "network" (the default) for a connection as it is, "tls" or "ssl" for TLS. */
  type?: "plain" | "network" | "tls" | "ssl" | "starttls" | "shell";
  coding?: string | [string, string];
  /** With "tls", a key and certificate file to offer the server. */
  clientCertificate?: [string, string] | null;
  /** With "plain", ask before using a connection that is not encrypted. */
  warnUnlessEncrypted?: boolean;
  /** Give [process, {greeting, capabilities, type, error}] rather than the process. */
  returnList?: boolean;
  capabilityCommand?: string;
  success?: string;
}

/**
 * Opens a connection to `host` and `service`, as open-network-stream:
 * plain, or with TLS, the certificate checked by the Network Security
 * Manager, which may refuse it. Returns the process, or undefined if the
 * user refused it; with `returnList`, a list as Emacs's.
 */
export function openNetworkStream(name: string, buffer: e8.BufferLike | null, host: string, service: number | string, parameters: NetworkStreamParameters = {}): e8.Process | undefined | [e8.Process | undefined, { type: string }] {
  const type = parameters.type ?? "network";
  let process: e8.Process | undefined;
  if (type === "plain" || type === "network") {
    if (type === "network" && parameters.success && parameters.capabilityCommand) throw new Error("STARTTLS connections are not supported in E8 yet");
    process = e8.makeNetworkProcess({ name, buffer: buffer ?? undefined, host, service, coding: parameters.coding });
    if (parameters.warnUnlessEncrypted) process = nsmVerifyConnection(process, host, service, false, true);
  } else if (type === "tls" || type === "ssl") {
    process = nsmVerifyConnection(openGnutlsStream(name, buffer, host, service, parameters), host, service);
  } else if (type === "starttls" || type === "shell") {
    throw new Error(`${type} connections are not supported in E8 yet`);
  } else {
    throw new Error(`Invalid connection type ${type}`);
  }
  if (parameters.returnList) return [process, { type: type === "ssl" ? "tls" : type === "network" ? "plain" : type }];
  return process;
}

e8.defun("open-network-stream", (name: string, buffer: e8.BufferLike | null, host: string, service: number | string, ...rest: e8.Value[]) => {
  // Keyword arguments, as Lisp gives them.
  const params: NetworkStreamParameters = {};
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const [key, value] = [String(rest[i]).replace(/^:/, ""), rest[i + 1]];
    if (key === "type") params.type = String(value) as NetworkStreamParameters["type"];
    else if (key === "coding") params.coding = value as string;
    else if (key === "warn-unless-encrypted") params.warnUnlessEncrypted = value === true;
  }
  const result = openNetworkStream(name, buffer, host, service, params);
  return (Array.isArray(result) ? result[0] : result) ?? null;
});
