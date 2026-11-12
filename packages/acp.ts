// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Agent Client Protocol, after acp.el 0.18.2
// (https://github.com/xenodium/acp.el): a client that starts a coding agent,
// such as claude-agent-acp or gemini --experimental-acp, as a process and
// talks to it in JSON-RPC 2.0, one message to a line, over its standard
// input and output (https://agentclientprotocol.com). Requests go out with
// callbacks for their answer, or wait for it with `sync`; what the agent
// asks or tells the editor goes to the functions subscribed to it. Messages
// that come in wait in a queue that a timer drains within
// acp-drain-time-budget, so an agent that writes fast never holds up
// typing, and a handler that fails never stops the queue. The agent's
// standard error goes to a buffer of its own, and on to the error handlers.
//
// The client is a plain object, as acp.el's is an alist; agent-shell.ts
// uses it, and anything else that talks to an agent may.
//
// Copyright (C) 2024 Alvaro Ramirez
// Copyright (C) 2026 The E8 contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { executableFind } from "subr";

export const acpPackageVersion = "0.18.2";

const jsonrpcVersion = "2.0";

e8.defineVariable({
  name: "acp-logging-enabled",
  value: false,
  doc: "Whether ACP traffic and messages are logged, to each client's log and traffic buffers (acp-logs-buffer).",
});
e8.defineVariable({
  name: "acp-drain-time-budget",
  value: 0.02,
  doc:
    "Seconds one drain of a client's message queue may spend routing messages. Routing runs the client's handlers, " +
    "which usually draw; once the budget is spent, the drain goes on at the next timer, so the editor can redisplay " +
    "and read keys meanwhile. Order is kept and nothing is dropped. At least one message is routed each time, so a " +
    "budget smaller than one handler still makes progress. Null drains the whole queue at once.",
});
e8.defineVariable({
  name: "acp--shutdown-grace-period",
  value: 5,
  doc:
    "Seconds acp shutdown waits for the agent to exit before killing it. Shutdown first sends the agent's process " +
    "group SIGTERM, so the agent can stop the processes it started itself.",
});

// --- Messages ---------------------------------------------------------------

/** A JSON object, as messages are made of. */
export type Json = { [key: string]: any };

/** What a request or notification builder makes: the method and its parameters. */
export interface Outgoing {
  method: string;
  params?: Json;
}

/** What a response builder makes: the request answered, and its result or error. */
export interface Response {
  requestId: number | string;
  result?: unknown;
  error?: Json;
}

/** A JSON-RPC error object. */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A message as it came in: its text and what it parsed to. */
export interface Message {
  json: string | undefined;
  object: Json;
}

type OnSuccess = (result: any) => void;
type OnFailure = (error: RpcError, message?: Message) => void;

interface Pending {
  request: Json;
  buffer?: e8.BufferLike;
  onSuccess?: OnSuccess;
  onFailure?: OnFailure;
}

export interface RequestSenderArgs {
  client: Client;
  request: Outgoing;
  buffer?: e8.BufferLike;
  onSuccess?: OnSuccess;
  onFailure?: OnFailure;
  sync?: boolean;
}

/** A client: what makeClient makes, and every other function takes. */
export interface Client {
  contextBuffer?: e8.BufferLike;
  instanceCount: number;
  process: e8.Process | undefined;
  command: string;
  commandParams: string[];
  /** Strings of the form "VAR=value". */
  environmentVariables: string[];
  /** Requests sent and not answered yet, by id. */
  pendingRequests: Map<number | string, Pending>;
  requestId: number;
  notificationHandlers: ((notification: Json) => void)[];
  requestHandlers: ((request: Json) => void)[];
  errorHandlers: ((error: RpcError) => void)[];
  requestSender: (args: RequestSenderArgs) => unknown;
  notificationSender: (args: { client: Client; notification: Outgoing; sync?: boolean }) => unknown;
  requestResolver: (args: { client: Client; id: number | string }) => Pending | undefined;
  responseSender: (args: { client: Client; response: Response }) => void;
  outgoingRequestDecorator?: (request: Outgoing) => Outgoing | undefined | null;
  /** Its standard error's buffer, and how much of it the error handlers have seen. */
  stderrBuffer?: string;
  stderrSeen: number;
  stderrTimer?: number;
}

let instanceCount = 0;

/**
 * Makes a client, which starts its agent when it first sends something.
 * `contextBuffer` is current for the callbacks of sendRequest and the
 * subscriptions unless they name another. `command` is the program, and
 * `commandParams` its arguments; `environmentVariables` are "VAR=value"
 * strings. The senders, resolver and decorator are for customising, and
 * for tests.
 */
export function makeClient(options: {
  contextBuffer?: e8.BufferLike;
  command: string;
  commandParams?: string[];
  environmentVariables?: string[];
  requestSender?: Client["requestSender"];
  notificationSender?: Client["notificationSender"];
  requestResolver?: Client["requestResolver"];
  responseSender?: Client["responseSender"];
  outgoingRequestDecorator?: Client["outgoingRequestDecorator"];
}): Client {
  if (!options.command) e8.signal("error", ":command is required");
  instanceCount = instanceCount === Number.MAX_SAFE_INTEGER ? 0 : instanceCount + 1;
  return {
    contextBuffer: options.contextBuffer,
    instanceCount,
    process: undefined,
    command: options.command,
    commandParams: options.commandParams ?? [],
    environmentVariables: options.environmentVariables ?? [],
    pendingRequests: new Map(),
    requestId: 0,
    notificationHandlers: [],
    requestHandlers: [],
    errorHandlers: [],
    requestSender: options.requestSender ?? defaultRequestSender,
    notificationSender: options.notificationSender ?? defaultNotificationSender,
    requestResolver: options.requestResolver ?? (({ client, id }) => client.pendingRequests.get(id)),
    responseSender: options.responseSender ?? defaultResponseSender,
    outgoingRequestDecorator: options.outgoingRequestDecorator,
    stderrSeen: 0,
  };
}

/** Whether the client's agent has been started and is running. */
export function clientStartedP(client: Client): boolean {
  return client.process !== undefined && e8.processLiveP(client.process);
}

/** Runs `fn` in `buffer` if it is live, else in the client's context buffer if that is, else where it is. */
function inContext(client: Client, buffer: e8.BufferLike | undefined, fn: () => void): void {
  const live = (b: e8.BufferLike | undefined) => b !== undefined && b !== null && e8.getBuffer(b) !== undefined;
  const target = live(buffer) ? buffer : live(client.contextBuffer) ? client.contextBuffer : undefined;
  if (target === undefined) fn();
  else e8.withCurrentBuffer(target, fn);
}

/** Runs a handler, logging what it throws rather than letting it stop the drain. */
function contained(client: Client, label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    log(client, label, `Failed with error: ${describeError(e)}`);
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Starts the client's agent, failing if its program is not found or it is already running. */
function startClient(client: Client): void {
  if (!client.command) e8.signal("error", ":command is required");
  if (!executableFind(client.command)) {
    e8.signal("error", `"${client.command}" command line utility not found.  Please install it`);
  }
  if (clientStartedP(client)) e8.signal("error", "Client already started");
  let pendingInput = "";
  const queue: Message[] = [];
  let busy = false;
  const env: { [name: string]: string } = {};
  for (const pair of client.environmentVariables) {
    const i = pair.indexOf("=");
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const stderrBuffer = e8.getBufferCreate(`acp-client-stderr(${client.command})-${client.instanceCount}`).name!;
  client.stderrBuffer = stderrBuffer;
  client.stderrSeen = 0;
  // Drains the queue in order, within the time budget, going on at the next
  // timer when messages are left; the busy flag drops however a handler
  // exits, or no later message would ever be routed.
  const drain = () => {
    const budget = e8.variable("acp-drain-time-budget");
    const deadline = typeof budget === "number" ? Date.now() + budget * 1000 : undefined;
    let withinBudget = true;
    try {
      while (queue.length > 0 && withinBudget) {
        const message = queue.shift()!;
        contained(client, "ROUTING ERROR", () =>
          routeIncomingMessage({
            client,
            message,
            onNotification: (notification) => {
              for (const handler of client.notificationHandlers) {
                contained(client, "NOTIFICATION HANDLER ERROR", () => handler(notification));
              }
            },
            onRequest: (request) => {
              for (const handler of client.requestHandlers) {
                contained(client, "REQUEST HANDLER ERROR", () => handler(request));
              }
            },
          }),
        );
        // Checked after routing, so every drain routes at least one message.
        withinBudget = deadline === undefined || Date.now() < deadline;
      }
    } finally {
      // The flag stays up while a drain is due, so the filter schedules no second one.
      if (queue.length > 0) e8.runWithTimer(0, null, drain);
      else busy = false;
    }
  };
  const process = e8.makeProcess({
    name: `acp-client(${client.command})-${client.instanceCount}`,
    command: [client.command, ...client.commandParams],
    env,
    stderr: stderrBuffer,
    connectionType: "pipe",
    coding: "utf-8-unix",
    filter: (_process, input) => {
      if (client.process !== process) return;
      log(client, "INCOMING TEXT", input);
      pendingInput += input;
      let start = 0;
      let pos: number;
      while ((pos = pendingInput.indexOf("\n", start)) >= 0) {
        const json = pendingInput.slice(start, pos);
        start = pos + 1;
        log(client, "INCOMING LINE", json);
        let object: unknown;
        try {
          object = JSON.parse(json);
        } catch {
          log(client, "JSON PARSE ERROR", `Invalid JSON: ${json}`);
          continue;
        }
        if (object === null || typeof object !== "object" || Array.isArray(object)) {
          log(client, "JSON PARSE ERROR", `Not a message: ${json}`);
          continue;
        }
        queue.push({ json, object: object as Json });
        if (!busy) {
          busy = true;
          e8.runWithTimer(0, null, drain);
        }
      }
      pendingInput = pendingInput.slice(start);
      readStderr(client);
    },
    sentinel: (proc, event) => {
      readStderr(client);
      stopStderrTimer(client);
      if (e8.bufferLiveP(e8.getBuffer(stderrBuffer))) e8.call("kill-buffer", stderrBuffer);
      const status = e8.processStatus(proc);
      if (status === undefined || status === "exit" || status === "signal") failPendingRequests(client, event);
    },
  });
  e8.setProcessQueryOnExitFlag(process, false);
  client.process = process;
  // The agent may write to standard error with nothing on its output, as
  // when it fails to reach its API, so its buffer is looked at meanwhile too.
  client.stderrTimer = e8.runWithTimer(0.25, 0.25, () => readStderr(client));
}

function stopStderrTimer(client: Client): void {
  if (client.stderrTimer !== undefined) e8.cancelTimer(client.stderrTimer);
  client.stderrTimer = undefined;
}

/**
 * Hands what the agent wrote to standard error since last time to the
 * error handlers: an API error it reports, parsed, or the text itself, as
 * an internal error. Whitespace is kept, as handlers may join the pieces.
 */
function readStderr(client: Client): void {
  const name = client.stderrBuffer;
  if (name === undefined || e8.getBuffer(name) === undefined) return;
  const raw = e8.withCurrentBuffer(name, () => {
    const size = e8.bufferSize();
    if (size <= client.stderrSeen) return "";
    const text = e8.bufferSubstringNoProperties(client.stderrSeen, size);
    client.stderrSeen = size;
    return text;
  });
  if (raw === "") return;
  log(client, "STDERR", raw.trim());
  const apiError = parseStderrApiError(raw);
  if (apiError) log(client, "API-ERROR", raw.trim());
  const error = apiError ?? makeInternalError(raw);
  for (const handler of client.errorHandlers) contained(client, "ERROR HANDLER ERROR", () => handler(error));
}

/** A JSON-RPC error made here rather than received: -32603 is JSON-RPC's "Internal error". */
function makeInternalError(message: string): RpcError {
  return makeError({ code: -32603, message });
}

/** Calls a request's failure callback with the error and the message that carried it. */
function callRequestFailure(client: Client, pending: Pending, error: RpcError, message: Message): void {
  inContext(client, pending.buffer, () => contained(client, "RESPONSE HANDLER ERROR", () => pending.onFailure!(error, message)));
}

/** Fails every request still waiting for an answer, as the agent's process ended (`event`). */
function failPendingRequests(client: Client, event: string): void {
  const pending = [...client.pendingRequests];
  client.pendingRequests.clear();
  const trimmed = event.trim();
  const base = "Agent process ended before completing request";
  const error = makeInternalError(trimmed === "" ? base : `${base}: ${trimmed}`);
  for (const [id, request] of pending) {
    if (!request.onFailure) continue;
    callRequestFailure(client, request, error, { json: undefined, object: { jsonrpc: jsonrpcVersion, id, error } });
  }
}

/** Subscribes `onNotification` to what the agent tells the editor, run in `buffer`. */
export function subscribeToNotifications(options: { client: Client; onNotification: (notification: Json) => void; buffer?: e8.BufferLike }): void {
  const { client, onNotification, buffer } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!onNotification) e8.signal("error", ":on-notification is required");
  client.notificationHandlers.unshift((notification) => inContext(client, buffer, () => onNotification(notification)));
}

/** Subscribes `onRequest` to what the agent asks of the editor, run in `buffer`; answer with sendResponse. */
export function subscribeToRequests(options: { client: Client; onRequest: (request: Json) => void; buffer?: e8.BufferLike }): void {
  const { client, onRequest, buffer } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!onRequest) e8.signal("error", ":on-request is required");
  client.requestHandlers.unshift((request) => inContext(client, buffer, () => onRequest(request)));
}

/**
 * Subscribes `onError` to the agent's own errors, what it writes to
 * standard error, run in `buffer`. A request's failure goes to its own
 * onFailure instead.
 */
export function subscribeToErrors(options: { client: Client; onError: (error: RpcError) => void; buffer?: e8.BufferLike }): void {
  const { client, onError, buffer } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!onError) e8.signal("error", ":on-error is required");
  client.errorHandlers.unshift((error) => inContext(client, buffer, () => onError(error)));
}

/**
 * Shuts the client down: forgets its handlers and pending requests, sends
 * its agent's process group SIGTERM and kills it after
 * acp--shutdown-grace-period, and kills its log buffers. Each part is
 * released whatever state the others are in, so it is safe to call again.
 */
export function shutdown(options: { client: Client }): void {
  const { client } = options;
  if (!client) e8.signal("error", ":client is required");
  client.errorHandlers = [];
  client.notificationHandlers = [];
  client.requestHandlers = [];
  client.pendingRequests.clear();
  stopStderrTimer(client);
  const process = client.process;
  if (process !== undefined) {
    // Unset first, so the filter ignores what still comes.
    client.process = undefined;
    if (e8.processLiveP(process)) {
      e8.signalProcess(process, "TERM");
      const grace = Number(e8.variable("acp--shutdown-grace-period") ?? 5);
      e8.runWithTimer(grace, null, () => {
        if (e8.processLiveP(process)) {
          try {
            e8.deleteProcess(process);
          } catch {
            // Gone meanwhile.
          }
        }
      });
    }
  }
  for (const name of [logsBufferName(client), trafficBufferName(client)]) {
    if (e8.getBuffer(name) !== undefined) e8.call("kill-buffer", name);
  }
}

/**
 * Sends a request, starting the agent if need be. `onSuccess` gets the
 * result and `onFailure` the error, run in `buffer`. With `sync`, waits for
 * the answer and returns the result, or signals the error; not from inside a
 * handler, whose drain the answer would wait behind.
 */
export function sendRequest(options: RequestSenderArgs): unknown {
  const { client, request } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!request) e8.signal("error", ":request is required");
  if (!clientStartedP(client)) startClient(client);
  return client.requestSender(options);
}

/** Sends a notification, starting the agent if need be. */
export function sendNotification(options: { client: Client; notification: Outgoing; sync?: boolean }): unknown {
  const { client, notification } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!notification) e8.signal("error", ":notification is required");
  if (!clientStartedP(client)) startClient(client);
  return client.notificationSender(options);
}

/** Answers a request the agent made, with a response from one of the make...Response builders. */
export function sendResponse(options: { client: Client; response: Response }): void {
  const { client, response } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!response) e8.signal("error", ":response is required");
  client.responseSender(options);
}

function send(client: Client, kind: string, object: Json): void {
  const json = JSON.stringify(object);
  log(client, "OUTGOING TEXT", json);
  logTraffic(client, "outgoing", kind, { json, object });
  if (client.process === undefined) e8.signal("error", "The agent is not running");
  e8.processSendString(client.process, `${json}\n`);
}

/** Waits for `done`, taking in the agent's output and running timers meanwhile. */
function waitFor(client: Client, done: () => boolean): void {
  while (!done()) {
    const process = client.process;
    if (process === undefined) break;
    e8.acceptProcessOutput(process, 0.01);
    if (!e8.processLiveP(process) && !done()) {
      // Its end, and the failure of what was pending, come with the next look.
      e8.acceptProcessOutput(undefined, 0.01);
      if (!done()) break;
    }
  }
}

function defaultRequestSender(options: RequestSenderArgs): unknown {
  const { client, buffer, onSuccess, onFailure, sync } = options;
  let request = options.request;
  if (!client) e8.signal("error", ":client is required");
  if (!request) e8.signal("error", ":request is required");
  if (!clientStartedP(client)) startClient(client);
  if (client.outgoingRequestDecorator) {
    const decorated = client.outgoingRequestDecorator(request);
    if (decorated) request = decorated;
    else log(client, "DECORATOR ERROR", `Outgoing request decorator returned nothing for "${request.method}", sending original request`);
  }
  const id = client.requestId + 1;
  client.requestId = id;
  const object: Json = { jsonrpc: jsonrpcVersion, method: request.method, id };
  if (request.params !== undefined) object.params = request.params;
  const pending: Pending = { request: object, buffer, onSuccess, onFailure };
  let result: unknown;
  let done: false | true | "error" = false;
  if (sync) {
    pending.onSuccess = (data) => {
      result = data;
      done = true;
    };
    pending.onFailure = (error) => {
      result = error;
      done = "error";
    };
  }
  client.pendingRequests.set(id, pending);
  send(client, "request", object);
  if (!sync) return undefined;
  waitFor(client, () => done !== false);
  if (done === false) e8.signal("error", `ACP request failed: the agent stopped before answering ${request.method}`);
  if (done === "error") e8.signal("error", `ACP request failed: ${JSON.stringify(result)}`);
  return result;
}

function defaultResponseSender(options: { client: Client; response: Response }): void {
  const { client, response } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!response) e8.signal("error", ":response is required");
  const object: Json =
    response.error !== undefined
      ? { jsonrpc: jsonrpcVersion, id: response.requestId, error: response.error }
      : { jsonrpc: jsonrpcVersion, id: response.requestId, result: response.result ?? null };
  send(client, "response", object);
}

function defaultNotificationSender(options: { client: Client; notification: Outgoing; sync?: boolean }): unknown {
  const { client, notification } = options;
  if (!client) e8.signal("error", ":client is required");
  if (!notification) e8.signal("error", ":notification is required");
  if (!clientStartedP(client)) startClient(client);
  const object: Json = { jsonrpc: jsonrpcVersion, method: notification.method };
  if (notification.params !== undefined) object.params = notification.params;
  send(client, "notification", object);
  return undefined;
}

// --- Builders ---------------------------------------------------------------

/** A directory as the protocol wants it: absolute, without a trailing slash. */
function directory(cwd: string): string {
  return e8.directoryFileName(e8.expandFileName(cwd));
}

/**
 * An "initialize" request: the protocol version, the client's name, title
 * and version, and whether it reads and writes text files and renders
 * elicitations as forms or URLs.
 */
export function makeInitializeRequest(options: {
  protocolVersion: number;
  clientInfo?: { name: string; title?: string; version?: string };
  readTextFileCapability?: boolean;
  writeTextFileCapability?: boolean;
  elicitationFormCapability?: boolean;
  elicitationUrlCapability?: boolean;
}): Outgoing {
  if (options.protocolVersion === undefined) e8.signal("error", ":protocol-version is required");
  const capabilities: Json = {
    fs: { readTextFile: Boolean(options.readTextFileCapability), writeTextFile: Boolean(options.writeTextFileCapability) },
  };
  if (options.elicitationFormCapability || options.elicitationUrlCapability) {
    const elicitation: Json = {};
    if (options.elicitationFormCapability) elicitation.form = {};
    if (options.elicitationUrlCapability) elicitation.url = {};
    capabilities.elicitation = elicitation;
  }
  const params: Json = {};
  if (options.clientInfo) params.clientInfo = options.clientInfo;
  params.protocolVersion = options.protocolVersion;
  params.clientCapabilities = capabilities;
  return { method: "initialize", params };
}

/** An "authenticate" request, with the authentication method's id. */
export function makeAuthenticateRequest(options: { methodId: string; method?: Json }): Outgoing {
  if (!options.methodId) e8.signal("error", ":method-id is required");
  const params: Json = { methodId: options.methodId };
  if (options.method) params.authMethod = options.method;
  return { method: "authenticate", params };
}

/**
 * A "session/new" request, for a session working in `cwd` with these MCP
 * servers. `meta` goes as _meta: a systemPrompt there replaces the
 * agent's, or with { append } adds to it.
 */
export function makeSessionNewRequest(options: { cwd: string; mcpServers?: Json[]; meta?: Json }): Outgoing {
  if (!options.cwd) e8.signal("error", ":cwd is required");
  const params: Json = { cwd: directory(options.cwd), mcpServers: options.mcpServers ?? [] };
  if (options.meta) params._meta = options.meta;
  return { method: "session/new", params };
}

/** A "session/prompt" request: the content blocks of the user's turn. */
export function makeSessionPromptRequest(options: { sessionId: string; prompt: Json[] }): Outgoing {
  if (!options.sessionId) e8.signal("error", ":session-id is required");
  if (!options.prompt) e8.signal("error", ":prompt is required");
  return { method: "session/prompt", params: { sessionId: options.sessionId, prompt: [...options.prompt] } };
}

/** A "session/set_mode" request, as "default", "plan", "acceptEdits" or "bypassPermissions". */
export function makeSessionSetModeRequest(options: { sessionId: string; modeId: string }): Outgoing {
  if (!options.sessionId) e8.signal("error", ":session-id is required");
  if (!options.modeId) e8.signal("error", ":mode-id is required");
  return { method: "session/set_mode", params: { sessionId: options.sessionId, modeId: options.modeId } };
}

/** A "session/set_model" request, an extension of Claude's adapter. */
export function makeSessionSetModelRequest(options: { sessionId: string; modelId: string }): Outgoing {
  if (!options.sessionId) e8.signal("error", ":session-id is required");
  if (!options.modelId) e8.signal("error", ":model-id is required");
  return { method: "session/set_model", params: { sessionId: options.sessionId, modelId: options.modelId } };
}

/** A "session/set_config_option" request: the option's id and one of its values. */
export function makeSessionSetConfigOptionRequest(options: { sessionId: string; configId: string; value: unknown }): Outgoing {
  if (!options.sessionId) e8.signal("error", ":session-id is required");
  if (!options.configId) e8.signal("error", ":config-id is required");
  if (options.value === undefined || options.value === null) e8.signal("error", ":value is required");
  return { method: "session/set_config_option", params: { sessionId: options.sessionId, configId: options.configId, value: options.value } };
}

function sessionParams(name: string, options: { sessionId: string; cwd: string; mcpServers?: Json[]; meta?: Json }): Outgoing {
  if (!options.sessionId) e8.signal("error", ":session-id is required");
  if (!options.cwd) e8.signal("error", ":cwd is required");
  const params: Json = { sessionId: options.sessionId, cwd: directory(options.cwd), mcpServers: options.mcpServers ?? [] };
  if (options.meta) params._meta = options.meta;
  return { method: name, params };
}

/** A "session/resume" request, which resumes a session without replaying it, where the agent can. */
export function makeSessionResumeRequest(options: { sessionId: string; cwd: string; mcpServers?: Json[]; meta?: Json }): Outgoing {
  return sessionParams("session/resume", options);
}

/** A "session/fork" request: a new session sharing another's conversation so far. */
export function makeSessionForkRequest(options: { sessionId: string; cwd: string; mcpServers?: Json[]; meta?: Json }): Outgoing {
  return sessionParams("session/fork", options);
}

/** A "session/load" request, which replays a session's history as updates. */
export function makeSessionLoadRequest(options: { sessionId: string; cwd: string; mcpServers?: Json[]; meta?: Json }): Outgoing {
  return sessionParams("session/load", options);
}

/**
 * A "session/list" request, of the sessions in `cwd`, or everywhere
 * without it; `cursor` is the nextCursor of the page before.
 */
export function makeSessionListRequest(options: { cwd?: string; cursor?: string } = {}): Outgoing {
  const params: Json = {};
  if (options.cwd) params.cwd = directory(options.cwd);
  if (options.cursor) params.cursor = options.cursor;
  return { method: "session/list", params };
}

/** A "session/delete" request. */
export function makeSessionDeleteRequest(options: { sessionId: string }): Outgoing {
  if (!options.sessionId) e8.signal("error", ":session-id is required");
  return { method: "session/delete", params: { sessionId: options.sessionId } };
}

/** The answer to "session/request_permission": the option the user chose, or that it was cancelled. */
export function makeSessionRequestPermissionResponse(options: { requestId: number | string; optionId?: string; cancelled?: boolean }): Response {
  if (options.requestId === undefined || options.requestId === null) e8.signal("error", ":request-id is required");
  if (options.optionId && options.cancelled) e8.signal("error", "Choose :option-id or :cancelled Not both");
  if (!options.optionId && !options.cancelled) e8.signal("error", "Must specify either :option-id or :cancelled");
  return {
    requestId: options.requestId,
    result: { outcome: options.cancelled ? { outcome: "cancelled" } : { outcome: "selected", optionId: options.optionId } },
  };
}

/** The answer to "fs/read_text_file": the file's text, or an error. */
export function makeFsReadTextFileResponse(options: { requestId: number | string; content?: string; error?: RpcError }): Response {
  if (options.requestId === undefined || options.requestId === null) e8.signal("error", ":request-id is required");
  if (options.content !== undefined && options.error) e8.signal("error", "Either :content or :error but not both");
  if (options.error) return { requestId: options.requestId, error: options.error as unknown as Json };
  if (options.content !== undefined) return { requestId: options.requestId, result: { content: options.content } };
  return e8.signal("error", "Either :content or :error is required");
}

/** The answer to "fs/write_text_file": nothing, or an error. */
export function makeFsWriteTextFileResponse(options: { requestId: number | string; error?: RpcError }): Response {
  if (options.requestId === undefined || options.requestId === null) e8.signal("error", ":request-id is required");
  return options.error ? { requestId: options.requestId, error: options.error as unknown as Json } : { requestId: options.requestId, result: null };
}

/** A JSON-RPC error object. */
export function makeError(options: { code: number; message: string; data?: unknown }): RpcError {
  if (options.code === undefined) e8.signal("error", ":code is required");
  if (options.message === undefined) e8.signal("error", ":message is required");
  const error: RpcError = { code: options.code, message: options.message };
  if (options.data !== undefined && options.data !== null) error.data = options.data;
  return error;
}

/** A "session/cancel" notification, which stops the session's turn. */
export function makeSessionCancelNotification(options: { sessionId: string; reason?: string }): Outgoing {
  if (!options.sessionId) e8.signal("error", ":session-id is required");
  const params: Json = { sessionId: options.sessionId };
  if (options.reason) params.reason = options.reason;
  return { method: "session/cancel", params };
}

// --- Routing ------------------------------------------------------------------

/**
 * Routes a message that came in: an answer to a request goes to its
 * callback, a request from the agent to `onRequest` and a notification to
 * `onNotification`; anything else is logged. Exported for tests and fakes.
 */
export function routeIncomingMessage(options: {
  client: Client;
  message: Message;
  onNotification: (notification: Json) => void;
  onRequest: (request: Json) => void;
}): boolean {
  const { client, message, onNotification, onRequest } = options;
  const object = message.object;
  const id = object.id;
  const hasId = id !== undefined && id !== null;
  // A result, even null, answers a request.
  if (hasId && "result" in object) {
    const pending = client.requestResolver({ client, id });
    if (pending) {
      log(client, undefined, "↳ Routing as response (result)");
      logTraffic(client, "incoming", "response", message);
      client.pendingRequests.delete(id);
      if (pending.onSuccess) {
        inContext(client, pending.buffer, () => contained(client, "RESPONSE HANDLER ERROR", () => pending.onSuccess!(object.result)));
      } else {
        log(client, undefined, `Unhandled result:\n\n${message.json}`);
      }
      return true;
    }
  }
  if (hasId && object.error) {
    const pending = client.requestResolver({ client, id });
    if (pending) {
      log(client, undefined, "↳ Routing as response (error)");
      logTraffic(client, "incoming", "response", message);
      client.pendingRequests.delete(id);
      if (pending.onFailure) callRequestFailure(client, pending, object.error, message);
      else log(client, undefined, `Unhandled error:\n\n${message.json}`);
      return true;
    }
  }
  if (object.method && hasId) {
    log(client, undefined, "↳ Routing as incoming request");
    logTraffic(client, "incoming", "request", message);
    onRequest(object);
    return true;
  }
  if (!hasId) {
    log(client, undefined, "↳ Routing as notification");
    logTraffic(client, "incoming", "notification", message);
    onNotification(object);
    return true;
  }
  log(client, undefined, `↳ Routing undefined (could not recognize)\n\n${message.json}`);
  logTraffic(client, "incoming", "unknown", message);
  return false;
}

/**
 * The API error in what an agent wrote to standard error, as Claude's
 * adapter reports a failed attempt: "Attempt N failed with status S.
 * Retrying ... ApiError: {json}", whose message holds the error as JSON.
 */
export function parseStderrApiError(raw: string): RpcError | undefined {
  const match = /Attempt (\d+) failed with status (\d+)\. Retrying.*ApiError: (\{.*\})/.exec(raw);
  if (!match) return undefined;
  try {
    const outer = JSON.parse(match[3]);
    const inner = JSON.parse(outer?.error?.message);
    return inner?.error ?? undefined;
  } catch {
    return undefined;
  }
}

// --- Logs ---------------------------------------------------------------------

/** The most the log buffer holds, in characters; older entries go first. */
const logBufferMax = 100 * 1000 * 1000;

function logsBufferName(client: Client): string {
  return `*acp-(${client.command})-${client.instanceCount} log*`;
}

function trafficBufferName(client: Client): string {
  return `*acp-(${client.command})-${client.instanceCount} traffic*`;
}

/** The client's log buffer, made if there is none. */
export function logsBuffer(options: { client: Client }): e8.Buffer {
  const name = logsBufferName(options.client);
  const existing = e8.getBuffer(name);
  if (existing) return existing;
  const buffer = e8.getBufferCreate(name);
  e8.bufferDisableUndo(buffer);
  return buffer;
}

/** The client's traffic buffer, a line for each message in or out, made if there is none. */
export function trafficBuffer(options: { client: Client }): e8.Buffer {
  const name = trafficBufferName(options.client);
  const existing = e8.getBuffer(name);
  if (existing) return existing;
  const buffer = e8.getBufferCreate(name);
  e8.bufferDisableUndo(buffer);
  return buffer;
}

/** Empties the client's log and traffic buffers. */
export function resetLogs(options: { client: Client }): void {
  for (const buffer of [logsBuffer(options), trafficBuffer(options)]) {
    e8.withCurrentBuffer(buffer, () => e8.deleteRegion(0, e8.bufferSize()));
  }
}

/** The text of a log entry: its label and body, with a blank line after. */
export function formatLogMessage(label: string | undefined, body: string): string {
  return label ? `${label} >\n\n${body}\n\n` : `${body}\n\n`;
}

/** Appends text to a buffer; an entry of a log is marked where it starts, for trimming. */
function appendTo(buffer: e8.Buffer, text: string, entry = false): void {
  e8.withCurrentBuffer(buffer, () => {
    e8.saveExcursion(() => {
      const start = e8.bufferSize();
      e8.gotoChar(start);
      e8.insert(text);
      if (entry && text !== "") e8.putTextProperty(start, start + 1, "acp-log-boundary", true);
    });
  });
}

/** Logs to the client's log buffer, when acp-logging-enabled is on. */
function log(client: Client, label: string | undefined, body: string): void {
  if (e8.variable("acp-logging-enabled") !== true) return;
  const buffer = logsBuffer({ client });
  appendTo(buffer, formatLogMessage(label, body), true);
  trimLogBuffer(buffer);
}

/**
 * Trims a log buffer to `max` characters, the oldest entries going first,
 * whole: what is cut is up to the first entry that starts past the cut.
 */
export function trimLogBuffer(buffer: e8.BufferLike, max = logBufferMax): void {
  if (e8.getBuffer(buffer) === undefined) return;
  e8.withCurrentBuffer(buffer, () => {
    const size = e8.bufferSize();
    if (size <= max) return;
    let at = size - max;
    // An entry starting right at the cut is kept whole, so the search starts past it.
    if (e8.getTextProperty(at, "acp-log-boundary")) at += 1;
    let next = at;
    while (next < size && !e8.getTextProperty(next, "acp-log-boundary")) {
      next = e8.nextSinglePropertyChange(next, "acp-log-boundary", size) ?? size;
    }
    e8.deleteRegion(0, next);
  });
}

/** Logs a message in or out to the client's traffic buffer, when acp-logging-enabled is on. */
function logTraffic(client: Client, direction: "incoming" | "outgoing", kind: string, message: Message): void {
  if (e8.variable("acp-logging-enabled") !== true) return;
  const arrow = direction === "incoming" ? "←" : "→";
  const method = message.object.method ?? (message.object.id !== undefined ? `#${message.object.id}` : "");
  appendTo(trafficBuffer({ client }), `${arrow} ${kind} ${method} ${message.json ?? JSON.stringify(message.object)}\n`);
}
