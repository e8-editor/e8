// Shell source blocks, after Org's ob-shell.el: C-c C-c runs a block of
// sh, bash, zsh or another of org-babel-shell-names in that shell, and a
// block of shell in shell-file-name. Its variables are assigned first, a
// table as tab-separated lines, or in bash as an array; what it prints is
// its result, read as a table unless :results says otherwise, or with
// :results value its exit code. With :stdin or :cmdline it runs as a
// script with that input or those arguments, with :shebang as a script
// of that interpreter, and with :session in a shell buffer that lasts.

import {
  assq,
  babelEval,
  expandBodyGeneric,
  getVars,
  importTable,
  pickName,
  reassembleTable,
  refResolve,
  resultCond,
} from "ob-core";
import { sendInput } from "comint";
import { startShell } from "shell";
import { truthy } from "subr";

e8.defineVariable({ name: "org-babel-default-header-args:shell", doc: "The header arguments shell blocks have unless they say otherwise.", value: [] });
e8.defineVariable({
  name: "org-babel-shell-names",
  doc: "The shells whose blocks run, each in itself. Call org-babel-shell-initialize after changing it.",
  value: ["sh", "bash", "zsh", "fish", "csh", "ash", "dash", "ksh", "mksh", "posh"],
});
e8.defineVariable({
  name: "org-babel-shell-results-defaults-to-output",
  doc: "Whether a shell block with no :results gives what it prints, as :results output would, rather than its exit code.",
  value: true,
});
e8.defineVariable({ name: "org-babel-sh-eoe-indicator", doc: "The command that says, in a session, that a block has finished.", value: "echo 'org_babel_sh_eoe'" });
e8.defineVariable({ name: "org-babel-sh-eoe-output", doc: "What org-babel-sh-eoe-indicator prints.", value: "org_babel_sh_eoe" });
e8.defineVariable({ name: "org-babel-sh-prompt", doc: "The prompt a session's shell is given, to tell its output from its prompts.", value: "org_babel_sh_prompt> " });
e8.defineVariable({
  name: "org-babel-shell-set-prompt-commands",
  doc: "For each shell, the command that sets its prompt, %s standing for the prompt; t is any other shell's.",
  value: [
    ["fish", 'function fish_prompt\n\techo "%s"\nend'],
    ["csh", 'set prompt="%s"\nset prompt2=""'],
    [true, 'PROMPT_COMMAND=;PS1="%s";PS2='],
  ],
});

const str = (v: e8.Value | undefined): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));

/** A value as Lisp's format "%S" writes it, a string as it is, as ob-shell's echo-var. */
const echo = (v: e8.Value): string => (typeof v === "string" ? v : v === null || v === undefined ? "nil" : e8.prin1ToString(v));

/**
 * A table as lines of fields joined by SEP, as orgtbl-to-generic writes it
 * with :fmt: a rule as HLINE, or left out without one.
 */
function tableToGeneric(table: e8.Value[], sep: string, hline: string | undefined): string {
  const lines: string[] = [];
  for (const row of table) {
    if (row === "hline") {
      if (hline !== undefined) lines.push(hline);
    } else lines.push((Array.isArray(row) ? row : [row]).map(echo).join(sep));
  }
  return lines.join("\n");
}

/** A value as text, as org-babel-sh-var-to-string: a table's rows as lines of fields, a list's elements one to a line. */
export function varToString(v: e8.Value, sep?: string, hline?: string): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    if (v.length > 0 && (Array.isArray(v[0]) || v[0] === "hline")) return tableToGeneric(v as e8.Value[], sep ?? "\t", hline);
    return (v as e8.Value[]).map(echo).join("\n");
  }
  return echo(v);
}

/** A value quoted for the shell, as org-babel-sh-var-to-sh. */
export const varToSh = (v: e8.Value, sep?: string, hline?: string): string => `'${varToString(v, sep, hline).replace(/'/g, `'"'"'`)}'`;

/** A variable's assignment as bash makes it, as org-babel--variable-assignments:bash: a table as an associative array, a list as an array. */
function bashAssignment(name: string, values: e8.Value, sep?: string, hline?: string): string {
  if (Array.isArray(values) && values.length > 0 && Array.isArray(values[0]) && (values[0] as e8.Value[]).length >= 2) {
    const items = (values as e8.Value[]).map((row) => {
      const r = Array.isArray(row) ? (row as e8.Value[]) : [row];
      return `${name}[${varToSh(r[0], sep, hline)}]=${varToSh(r.slice(1), sep, hline)}`;
    });
    return `unset ${name}\ndeclare -A ${name}\n${items.join("\n")}`;
  }
  if (Array.isArray(values) && values.length > 0)
    return `unset ${name}\ndeclare -a ${name}=( ${(values as e8.Value[]).map((x) => varToSh(x, sep, hline)).join(" ")} )`;
  return `${name}=${varToSh(values, sep, hline)}`;
}

/** The shell statements assigning a block's variables, as org-babel-variable-assignments:shell, for the shell shell-file-name names. */
export function variableAssignments(params: e8.Value): string[] {
  const sep = str(assq(params, ":separator"));
  const hline = assq(params, ":hlines") === "yes" ? (str(assq(params, ":hline-string")) ?? "hline") : undefined;
  const shell = String(e8.variable("shell-file-name") ?? "");
  return getVars(params).map(([name, value]) =>
    shell.endsWith("bash") ? bashAssignment(name, value, sep, hline) : shell.endsWith("fish") ? `set ${name} ${varToSh(value, sep, hline)}` : `${name}=${varToSh(value, sep, hline)}`,
  );
}

/** Whether a block's result is its exit code, as ob-shell decides: with :results value, or with no :results when that is not output. */
function valueIsExitStatus(rp: e8.Value | undefined): boolean {
  const p = Array.isArray(rp) ? (rp as string[]) : [];
  return (p.length === 1 && p[0] === "replace" && !truthy(e8.variable("org-babel-shell-results-defaults-to-output"))) || p.includes("value");
}

/** Writes a script of BODY, after SHEBANG's line and a blank line unless :padline no, which may be run, as ob-shell writes one. */
function writeScript(body: string, shebang: string | undefined, params: e8.Value): string {
  const padline = assq(params, ":padline") !== "no";
  const file = e8.makeTempFile("sh-script-", { text: `${shebang !== undefined ? `${shebang}\n` : ""}${padline ? "\n" : ""}${body}` });
  e8.setFileModes(file, 0o755);
  return file;
}

/**
 * Runs a shell block's code, as org-babel-sh-evaluate: in SESSION, as a
 * script with STDIN as its input or CMDLINE as its arguments, as a script
 * of its :shebang, or else as the shell's input. What it printed, read as
 * its :results want it.
 */
function evaluate(session: string | undefined, body: string, params: e8.Value, stdin?: string, cmdline?: string): e8.Value {
  const shebang = str(assq(params, ":shebang"));
  const rp = assq(params, ":result-params");
  let results: string | undefined;
  const shell = String(e8.variable("shell-file-name") ?? "sh");
  if (stdin !== undefined || cmdline !== undefined) {
    const script = writeScript(body, assq(params, ":shebang") === undefined ? undefined : String(assq(params, ":shebang") ?? ""), params);
    const input = e8.makeTempFile("sh-stdin-", { text: stdin ?? "" });
    const buffer = e8.generateNewBufferName(" *org-babel-sh*");
    e8.getBufferCreate(buffer);
    try {
      results = e8.withCurrentBuffer(buffer, () => {
        if (shebang !== undefined) e8.callProcess(script, input, true, null, ...(cmdline !== undefined ? [cmdline] : []));
        else e8.callProcess(shell, input, true, null, String(e8.variable("shell-command-switch") ?? "-c"), `${script} ${cmdline ?? ""}`);
        return e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
      });
    } finally {
      e8.call("kill-buffer", buffer);
      for (const f of [script, input]) if (e8.fileExistsP(f)) e8.deleteFile(f);
    }
  } else if (session !== undefined) results = sessionEvaluate(session, body);
  else if (shebang !== undefined && shebang.trim() !== "") {
    const script = writeScript(body, shebang, params);
    try {
      results = babelEval(script, "");
    } finally {
      if (e8.fileExistsP(script)) e8.deleteFile(script);
    }
  } else results = babelEval(shell, body.trim());
  if (results !== undefined && valueIsExitStatus(rp)) {
    const lines = results.split("\n").filter((l) => l !== "");
    results = lines.length ? lines[lines.length - 1] : undefined;
  }
  if (results === undefined) return null;
  const text = results;
  return resultCond(rp, text, () => importTable(text));
}

/**
 * Runs a shell block, as org-babel-execute:shell: its variables assigned
 * after its :prologue, its :epilogue after it, and with :results value an
 * echo of its exit code; its table's column and row names put back.
 */
export function executeShell(body: string, params: e8.Value): e8.Value {
  const session = initiateSession(str(assq(params, ":session")));
  const stdinRef = str(assq(params, ":stdin"));
  const stdin = stdinRef !== undefined ? varToString(refResolve(stdinRef)) : undefined;
  const cmdline = assq(params, ":cmdline");
  const rp = assq(params, ":result-params");
  const fullBody = expandBodyGeneric(body, params, variableAssignments(params)) + (valueIsExitStatus(rp) ? "\necho $?" : "");
  const result = evaluate(session, fullBody, params, stdin, cmdline === undefined || cmdline === null ? undefined : String(cmdline));
  return reassembleTable(result, pickName(assq(params, ":colname-names"), assq(params, ":colnames")), pickName(assq(params, ":rowname-names"), assq(params, ":rownames")));
}

e8.defun("org-babel-execute:shell", executeShell);
e8.defun("org-babel-variable-assignments:shell", variableAssignments);

/** Defines the functions that run each of org-babel-shell-names's shells' blocks, as org-babel-shell-initialize. */
function initialize(): void {
  const names = e8.variable("org-babel-shell-names");
  for (const name of Array.isArray(names) ? (names as string[]) : []) {
    e8.defun(`org-babel-execute:${name}`, (body: string, params: e8.Value) =>
      e8.letBind({ "explicit-shell-file-name": name, "shell-file-name": name }, () => executeShell(body, params)),
    );
    e8.defun(`org-babel-variable-assignments:${name}`, variableAssignments);
    e8.defun(`org-babel-prep-session:${name}`, (session: string, params: e8.Value) =>
      e8.letBind({ "explicit-shell-file-name": name, "shell-file-name": name }, () => prepSession(session, params)),
    );
    if (e8.variable(`org-babel-default-header-args:${name}`) === undefined)
      e8.defineVariable({ name: `org-babel-default-header-args:${name}`, doc: `The header arguments ${name} blocks have unless they say otherwise.`, value: e8.variable("org-babel-default-header-args:shell") ?? [] });
  }
}

e8.defineCommand({
  name: "org-babel-shell-initialize",
  doc: "Define the functions that run the blocks of each shell org-babel-shell-names lists.",
  run: () => initialize(),
});

initialize();

// --- Sessions, as ob-shell.el runs them through ob-comint.el ------------------

/** Whether BUFFER is a shell's, with its process running, as org-babel-comint-buffer-livep. */
function comintLive(buffer: string): boolean {
  if (e8.getBuffer(buffer) === undefined) return false;
  const p = e8.getBufferProcess(buffer);
  return p !== undefined && e8.processLiveP(p);
}

/** How long to wait for a shell's output before trying again, as org-babel-comint-fallback-regexp-threshold. */
e8.defineVariable({ name: "org-babel-comint-fallback-regexp-threshold", doc: "How many seconds to wait for a session's prompt at a time.", value: 5.0 });

const quote = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The session's prompt, as a JavaScript regexp for its lines. */
const promptRegexp = (): RegExp => new RegExp(`^${quote(String(e8.variable("org-babel-sh-prompt")))} *`, "m");

/**
 * Sends what is after BUFFER's process mark to its shell, as
 * comint-send-input, and waits until what the shell writes back shows the
 * session's prompt, after what AFTER matches if given, as
 * org-babel-comint-wait-for-output and org-babel-comint-with-output wait:
 * as long as the code runs, as Org waits; C-g stops it. What the shell
 * wrote, collected from comint-output-filter-functions as it came.
 */
function sendAndWait(buffer: string, after?: RegExp): string {
  let output = "";
  const collect = (text: e8.Value) => {
    output += String(text);
  };
  const process = e8.getBufferProcess(buffer);
  e8.withCurrentBuffer(buffer, () => e8.addHook("comint-output-filter-functions", collect, { local: true }));
  try {
    e8.withCurrentBuffer(buffer, () =>
      // Kept out of the shell's input history, as ob-comint binds comint-input-filter.
      e8.letBind({ "comint-input-filter": "org-babel-comint--no-history" }, () => {
        e8.gotoChar(e8.pointMax());
        sendInput(false, true);
      }),
    );
    for (;;) {
      const m = after === undefined ? { index: 0, 0: "" } : after.exec(output);
      if (m !== null && promptRegexp().test(output.slice(m.index + m[0].length))) return output;
      if (process === undefined || !e8.processLiveP(process)) e8.signal("error", `Buffer ${buffer} does not exist or has no process`);
      e8.acceptProcessOutput(process, 0.1);
    }
  } finally {
    if (e8.bufferLiveP(e8.getBuffer(buffer))) e8.withCurrentBuffer(buffer, () => e8.removeHook("comint-output-filter-functions", collect, { local: true }));
  }
}

e8.defun("org-babel-comint--no-history", () => false);

/**
 * Asks, while an agent acts, the user's approval of running CODE in
 * SESSION's shell, as starting a program asks it: an error until it is
 * given, before anything is typed there.
 */
function approve(session: string, code: string): void {
  e8.checkPermission(`run in the shell of ${session}: ${code.trim()}`);
}

/** Types CMD into BUFFER's shell and waits for its prompt, as org-babel-comint-input-command. */
function inputCommand(buffer: string, cmd: string): void {
  e8.withCurrentBuffer(buffer, () =>
    e8.saveExcursion(() => {
      e8.gotoChar(e8.processMark(e8.getBufferProcess(buffer)!) ?? e8.pointMax());
      e8.insert(cmd);
    }),
  );
  sendAndWait(buffer);
}

/**
 * The buffer of SESSION, its shell started if it is not running, with a
 * prompt Babel knows, as org-babel-sh-initiate-session; undefined for no
 * session.
 */
function initiateSession(session: string | undefined): string | undefined {
  if (session === undefined || session === "none") return undefined;
  if (comintLive(session)) return session;
  e8.saveWindowExcursion(() => startShell(session));
  // Its first prompt waited for, as shell-prompt-pattern finds one, so what is typed comes after it.
  const process = e8.getBufferProcess(session);
  const deadline = Date.now() + Number(e8.variable("org-babel-comint-fallback-regexp-threshold") ?? 5) * 1000;
  // A prompt of another shape is taken after a while, once the shell has written something.
  while (process !== undefined && e8.processLiveP(process)) {
    const text = e8.withCurrentBuffer(session, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()));
    if (/^[^#$%>\n]*[#$%>] *$/m.test(text) || (Date.now() > deadline && text !== "")) break;
    e8.acceptProcessOutput(process, 0.1);
  }
  const shell = String(e8.variable("shell-file-name") ?? "").replace(/.*\//, "");
  const commands = e8.variable("org-babel-shell-set-prompt-commands");
  const entry = Array.isArray(commands) ? ((commands as e8.Value[][]).find((c) => c[0] === shell) ?? (commands as e8.Value[][]).find((c) => c[0] === true)) : undefined;
  const prompt = String(e8.variable("org-babel-sh-prompt"));
  // The prompt it is given, which is how its output is told from its prompts.
  inputCommand(session, String(entry?.[1] ?? 'PROMPT_COMMAND=;PS1="%s";PS2=').split("%s").join(prompt));
  e8.withCurrentBuffer(session, () => {
    e8.makeLocalVariable("comint-prompt-regexp");
    e8.setVariable("comint-prompt-regexp", `^${prompt.replace(/[.*+?[\]^$\\]/g, "\\$&")} *`);
  });
  return session;
}

/**
 * Runs BODY in SESSION and gives what it printed, as ob-shell does through
 * org-babel-comint-with-output: the code typed after any input left at the
 * prompt, which is put back after, and then org-babel-sh-eoe-indicator,
 * and the output to that, the echoed code and the prompts left out.
 */
function sessionEvaluate(session: string, body: string): string {
  approve(session, body);
  const process = e8.getBufferProcess(session)!;
  let dangling = "";
  e8.withCurrentBuffer(session, () =>
    e8.saveExcursion(() => {
      const mark = e8.processMark(process) ?? e8.pointMax();
      dangling = e8.bufferSubstringNoProperties(mark, e8.pointMax());
      e8.deleteRegion(mark, e8.pointMax());
      e8.gotoChar(mark);
      e8.insert(`${body.trim()}\n${String(e8.variable("org-babel-sh-eoe-indicator"))}`);
    }),
  );
  let output: string;
  try {
    output = sendAndWait(session, new RegExp(quote(String(e8.variable("org-babel-sh-eoe-output")))));
  } finally {
    e8.withCurrentBuffer(session, () =>
      e8.saveExcursion(() => {
        e8.gotoChar(e8.processMark(process) ?? e8.pointMax());
        e8.insert(dangling);
      }),
    );
  }
  // The echoed code left out, as org-babel-comint--echo-filter.
  const echoed = new RegExp(quote(body.trim()).replace(/\n/g, "[\\r\\n]+")).exec(output);
  if (echoed) output = output.slice(echoed.index + echoed[0].length);
  // Split at the prompts, as org-babel-comint--prompt-filter: again while
  // one is left, as a prompt can follow another on the line it ends.
  const separator = "org-babel-comint--prompt-filter-separator\n";
  const prompt = new RegExp(`(?:${quote(separator)})?(?:${promptRegexp().source})[ \\t]*`, "gm");
  while (promptRegexp().test(output)) output = output.replace(prompt, separator);
  const parts = output.split(separator).filter((p) => p !== "");
  // The eoe indicator's output left out, each part trimmed, as ob-shell has them.
  return parts
    .slice(0, -1)
    .map((p) => p.trim())
    .map((p) => p.replace(/^(?:% +[\r\n$]+ *)+/, ""))
    .join("\n");
}

/** SESSION's shell with the block's variables assigned in it, as org-babel-prep-session:shell. */
export function prepSession(session: string, params: e8.Value): string | undefined {
  const buffer = initiateSession(session);
  if (buffer === undefined) return undefined;
  const lines = variableAssignments(params);
  if (lines.length) approve(buffer, lines.join("\n"));
  for (const line of lines) inputCommand(buffer, line);
  return buffer;
}

/** SESSION's shell with the block's variables assigned and BODY typed at its prompt, not sent, as org-babel-load-session:shell. */
export function loadSession(session: string, body: string, params: e8.Value): string | undefined {
  return e8.saveWindowExcursion(() => {
    const buffer = prepSession(session, params);
    if (buffer !== undefined)
      e8.withCurrentBuffer(buffer, () => {
        e8.gotoChar(e8.processMark(e8.getBufferProcess(buffer)!) ?? e8.pointMax());
        e8.insert(body.replace(/[ \f\t\n\r\v]+$/, ""));
      });
    return buffer;
  });
}

e8.defun("org-babel-prep-session:shell", prepSession);
e8.defun("org-babel-load-session:shell", loadSession);

