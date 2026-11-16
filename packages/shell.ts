// A shell in a buffer, after Emacs's shell.el: M-x shell runs your shell
// on a terminal in *shell*, in shell-mode, built on comint, which follows
// the directory as cd, pushd and popd change it.

import { makeComintInBuffer, outputFilter, readInputRing } from "comint";
import { eraseBuffer, PerBuffer } from "subr";

for (const [name, doc, value] of [
  ["explicit-shell-file-name", "The shell M-x shell runs, if not $ESHELL or shell-file-name.", null],
  ["explicit-bash-args", "What M-x shell gives bash: no line editing, and interactive.", ["--noediting", "-i"]],
  ["shell-prompt-pattern", "An Emacs regexp for a shell's prompt, which comint-prompt-regexp starts as in shell-mode.", "^[^#$%>\n]*[#$%>] *"],
  ["shell-dirtrack-mode", "Whether shell-mode follows cd, pushd and popd to keep default-directory where the shell is.", true],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value });
}

/** The directories pushd has pushed, newest first, as shell-dirstack. */
const dirstacks = new PerBuffer<string[]>();
/** The directory before the last change, where cd - goes, as shell-last-dir. */
const lastDirs = new PerBuffer<string>();

/**
 * A command's words with their quoting taken off, as shell-unquote-argument
 * does: '...' as it is, "..." and \x with the backslash gone.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (c === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i];
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + c;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** Follows a command that changes directory, as shell-directory-tracker: cd, pushd and popd. */
function directoryTracker(input: string): void {
  if (e8.variable("shell-dirtrack-mode") === false) return;
  const buffer = e8.bufferName();
  const stack = dirstacks.get(buffer) ?? [];
  dirstacks.set(buffer, stack);
  // Each command of a line like "cd a; ls".
  for (const command of input.split(/[;&|]+/)) {
    const [word, ...args] = shellWords(command.trim());
    if (!["cd", "chdir", "pushd", "popd"].includes(word ?? "")) continue;
    // $VAR and ${VAR} expanded, as comint-substitute-in-file-name does; a
    // name it cannot expand is not followed.
    let arg: string | undefined;
    try {
      arg = args[0] === undefined ? undefined : e8.substituteInFileName(args[0]);
    } catch {
      continue;
    }
    const here = String(e8.variable("default-directory") ?? "~/");
    const go = (dir: string) => {
      const expanded = e8.expandFileName(dir, here);
      if (!e8.fileDirectoryP(expanded)) return;
      lastDirs.set(buffer, here);
      e8.setVariable("default-directory", expanded.endsWith("/") ? expanded : `${expanded}/`);
    };
    if (word === "cd" || word === "chdir") {
      if (arg === undefined) go(e8.getenv("HOME") ?? "~");
      // The directory before the last change, as shell-last-dir.
      else if (arg === "-") go(lastDirs.get(buffer) ?? here);
      else go(arg);
    } else if (word === "pushd") {
      if (arg !== undefined) {
        stack.unshift(here);
        go(arg);
      } else if (stack.length > 0) {
        const top = stack.shift()!;
        stack.unshift(here);
        go(top);
      }
    } else if (word === "popd" && stack.length > 0) {
      go(stack.shift()!);
    }
  }
}
e8.defun("shell-directory-tracker", directoryTracker);

e8.defineVariable({
  name: "shell-history-file-name",
  doc: "The file shell-mode reads the history from: nil for $HISTFILE or the shell's own default, t for none.",
  value: null,
});
e8.defineVariable({ name: "shell--start-prog", doc: "The name of the shell this buffer runs.", value: null, local: true });
e8.put("shell--start-prog", "permanent-local", true);

/**
 * Reads the shell's history file into the buffer's history, as shell-mode
 * does: shell-history-file-name, else $HISTFILE, else the shell's own
 * default, with $HISTSIZE for the history's size.
 */
function historySetup(): void {
  const shell = String(e8.variable("shell--start-prog") ?? "");
  const named = e8.variable("shell-history-file-name");
  let file: string | undefined = typeof named === "string" ? named : named === null || named === undefined ? e8.getenv("HISTFILE") : undefined;
  if (file === "") file = undefined;
  if (file === undefined && (named === null || named === undefined)) {
    file = { bash: "~/.bash_history", ksh: "~/.sh_history", zsh: "~/.zsh_history" }[shell] ?? "~/.history";
  }
  if (file !== undefined) {
    const size = Number(e8.getenv("HISTSIZE") ?? "");
    if (Number.isInteger(size) && size > 0) {
      e8.makeLocalVariable("comint-input-ring-size");
      e8.setVariable("comint-input-ring-size", size);
    }
  }
  if (file !== undefined && e8.fileTruename(e8.expandFileName(file)) === e8.fileTruename("/dev/null")) file = undefined;
  e8.setVariable("comint-input-ring-file-name", file ?? null);
  if (shell === "zsh") {
    e8.setVariable("comint-input-ring-file-prefix", ": [[:digit:]]+:[[:digit:]]+;");
  }
  readInputRing(true);
}

e8.defineMajorMode({
  name: "shell-mode",
  modeName: "Shell",
  parent: "comint-mode",
  doc:
    "The major mode for a shell in a buffer: type commands after its prompt and send them with RET.\n\n" +
    "It is comint-mode, so M-p and M-n go through earlier commands and C-c C-c interrupts the job running, and " +
    "default-directory follows the shell's cd, pushd and popd.",
  setup: () => {
    e8.makeLocalVariable("comint-prompt-regexp");
    e8.setVariable("comint-prompt-regexp", e8.variable("shell-prompt-pattern") ?? null);
    e8.addHook("comint-input-filter-functions", directoryTracker, { local: true });
    historySetup();
  },
});

e8.defineCommand({
  name: "shell",
  doc:
    "Run your shell in the buffer *shell*, or go to it if it runs there already.\n\n" +
    "The shell is explicit-shell-file-name, else $ESHELL, else shell-file-name; bash runs with explicit-bash-args, " +
    "and other shells with -i, or the variable explicit-NAME-args. With a prefix argument, ask for the buffer.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: e8.PrefixArg) => {
    const buffer =
      arg === null ? "*shell*" : (await e8.readString("Shell buffer: ", { default: e8.generateNewBufferName("*shell*") })) || "*shell*";
    const running = e8.getBufferProcess(buffer);
    if (running === undefined || !e8.processLiveP(running)) {
      const program = String(e8.variable("explicit-shell-file-name") ?? e8.getenv("ESHELL") ?? e8.variable("shell-file-name") ?? "/bin/sh");
      const name = program.replace(/.*\//, "");
      const explicit = e8.variable(`explicit-${name}-args`);
      const args = Array.isArray(explicit) ? explicit.map(String) : ["-i"];
      const startfile = [`~/.emacs_${name}`, `~/.emacs.d/init_${name}.sh`].map((f) => e8.expandFileName(f)).find((f) => e8.fileExistsP(f));
      e8.getBufferCreate(buffer);
      e8.withCurrentBuffer(buffer, () => {
        e8.setVariable("shell--start-prog", name);
        if (e8.variable("major-mode") !== "shell-mode") e8.call("shell-mode");
      });
      makeComintInBuffer("shell", buffer, program, startfile, ...args);
    }
    e8.call("switch-to-buffer", buffer);
  },
});

// Shell commands in the background, as simple.el's async-shell-command:
// on a terminal, through comint's filter, in *Async Shell Command*.

e8.defineCommand({
  name: "async-shell-command",
  doc:
    "Run a shell command in the background, its output going into *Async Shell Command* as it comes.\n\n" +
    "When it ends, a message says how.",
  params: [{ name: "command", kind: "string", prompt: "Async shell command: " }],
  run: async (command: string) => {
    const name = String(e8.variable("shell-command-buffer-name-async"));
    let buffer = name;
    const running = e8.getBufferProcess(buffer);
    if (running !== undefined && e8.processLiveP(running)) {
      // As async-shell-command-buffer's confirm-new-buffer.
      if (!(await e8.yesOrNoP("A command is running in the default buffer.  Use a new buffer? "))) e8.userError("Shell command in progress");
      buffer = e8.generateNewBufferName(name);
    }
    const directory = e8.expandFileName(".");
    e8.getBufferCreate(buffer);
    e8.withCurrentBuffer(buffer, () => {
      e8.letBind({ "inhibit-read-only": true }, () => eraseBuffer());
      e8.makeLocalVariable("default-directory");
      e8.setVariable("default-directory", directory.endsWith("/") ? directory : `${directory}/`);
    });
    const shell = String(e8.variable("shell-file-name"));
    e8.makeProcess({
      name: "Shell",
      buffer,
      command: [shell, String(e8.variable("shell-command-switch")), command],
      directory,
      env: { TERM: String(e8.variable("comint-terminfo-terminal") ?? "dumb") },
      filter: (p, text) => outputFilter(p, text),
      sentinel: (_p, event) => {
        const status = e8.processStatus(_p);
        if (status === "exit" || status === "signal" || status === undefined) e8.message(`${command}: ${event.replace(/\n$/, "")}.`);
      },
    });
    e8.call("display-buffer", buffer);
  },
});

e8.bindKey("M-&", "async-shell-command");
