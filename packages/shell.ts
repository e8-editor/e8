// A shell in a buffer, after Emacs's shell.el: M-x shell runs your shell
// on a terminal in *shell*, in shell-mode, built on comint, which follows
// the directory as cd, pushd and popd change it.

import {
  comintDirectory,
  filenameCompletion,
  insertSuffix,
  lineBeginningPosition,
  makeComintInBuffer,
  matchPartialFilename,
  matchPartialFilenameRaw,
  outputFilter,
  readInputRing,
} from "comint";
import { eraseBuffer, PerBuffer } from "subr";

for (const [name, doc, value] of [
  ["explicit-shell-file-name", "The shell M-x shell runs, if not $ESHELL or shell-file-name.", null],
  ["explicit-bash-args", "What M-x shell gives bash: no line editing, and interactive.", ["--noediting", "-i"]],
  ["shell-prompt-pattern", "An Emacs regexp for a shell's prompt, which comint-prompt-regexp starts as in shell-mode.", "^[^#$%>\n]*[#$%>] *"],
  ["shell-dirtrack-mode", "Whether shell-mode follows cd, pushd and popd to keep default-directory where the shell is.", true],
  ["shell-completion-fignore", "Suffixes of file names that completion in shell-mode leaves out, as comint-completion-fignore there.", []],
  ["shell-delimiter-argument-list", "The characters that are arguments of their own in a shell command.", ["|", "&", "<", ">", "(", ")", ";"]],
  ["shell-file-name-chars", "The characters of a file name in shell-mode, as comint-file-name-chars there.", "[]~/A-Za-z0-9+@:_.$#%,={}-"],
  [
    "shell-file-name-quote-list",
    "The characters quoted with a backslash in a file name in shell-mode, as comint-file-name-quote-list there.",
    ["|", "&", "<", ">", "(", ")", ";", " ", "$", "*", "!", '"', "'", "`", "#", "\\"],
  ],
  ["shell-completion-execonly", "Whether completing a command offers only files that can be run.", true],
  ["shell-command-regexp", "An Emacs regexp matching one command of a pipeline.", "[^;&|\n]+"],
  [
    "shell-dynamic-complete-functions",
    "The functions that say what completes at point in shell-mode, as comint-dynamic-complete-functions there.",
    ["shell-environment-variable-completion", "shell-command-completion", "shell-c-a-p-replace-by-expanded-directory", "shell-filename-completion", "comint-filename-completion"],
  ],
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

// Moving over commands and completing at the prompt, as shell.el does.

/** Goes forward over n commands of the line, as shell-forward-command. */
function forwardCommand(n: number): void {
  const limit = e8.lineEndPosition();
  const pt = e8.point();
  const re = `${String(e8.variable("shell-command-regexp"))}\\([;&|][\t ]*\\)+`;
  for (let i = 0; i < n; i++) {
    if (e8.reSearchForward(re, { bound: limit, noerror: true }) === undefined) {
      e8.gotoChar(limit);
      break;
    }
  }
  if (pt !== e8.point()) e8.skipSyntaxBackward(" ", pt);
}

/** Goes back over n commands of the line, as shell-backward-command. */
function backwardCommand(n: number): void {
  let limit = e8.saveExcursion(() => lineBeginningPosition());
  if (limit > e8.point()) limit = e8.lineBeginningPosition();
  e8.skipSyntaxBackward(" ", limit);
  const pt = e8.point();
  const re = `[;&|]+[\t ]*\\(${String(e8.variable("shell-command-regexp"))}\\)`;
  let found = true;
  for (let i = 0; i < n && found; i++) found = e8.reSearchBackward(re, { bound: limit, noerror: true }) !== undefined;
  if (found) {
    e8.gotoChar(e8.matchBeginning(1)!);
    e8.skipCharsForward(";&|");
  } else e8.gotoChar(limit);
  if (pt !== e8.point()) e8.skipSyntaxForward(" ", pt);
}

e8.defineCommand({
  name: "shell-forward-command",
  doc: "Move forward over a command of the line, or as many as the prefix argument says. See shell-command-regexp.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => forwardCommand(n),
});

e8.defineCommand({
  name: "shell-backward-command",
  doc: "Move back over a command of the line, or as many as the prefix argument says. See shell-command-regexp.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => backwardCommand(n),
});

/** Adds a space after a command completed in full, as shell's command completion does. */
const spaceAfter = (_text: string, status: string) => {
  if (status === "sole" || status === "finished") insertSuffix(" ");
};

/**
 * What completes the command before point: the programs in exec-path's
 * directories starting with it, and the directories in the current one, as
 * shell--command-completion-data.
 */
function commandCompletionData(): e8.Value[] {
  const word = matchPartialFilenameRaw();
  const filename = matchPartialFilename() ?? "";
  const start = filename === "" || word === undefined ? e8.point() : word.start;
  const end = filename === "" || word === undefined ? e8.point() : word.end;
  const nondir = filename.replace(/.*\//, "");
  const names = () => {
    const cwd = e8.fileNameAsDirectory(e8.expandFileName(String(e8.variable("default-directory") ?? ".")));
    const ignored = ((e8.variable("comint-completion-fignore") ?? []) as e8.Value[]).map(String).filter((x) => x !== "");
    const execonly = e8.variable("shell-completion-execonly");
    const found: string[] = [];
    for (const d of (e8.variable("exec-path") ?? []) as e8.Value[]) {
      const dir = e8.fileNameAsDirectory(comintDirectory(typeof d === "string" ? d : "."));
      if (!e8.fileAccessibleDirectoryP(dir)) continue;
      let files: string[];
      try {
        files = e8.fileNameAllCompletions(nondir, dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const abs = dir + file;
        if (found.includes(file) || ignored.some((x) => file.endsWith(x))) continue;
        if (dir !== cwd && e8.fileDirectoryP(abs)) continue;
        if (execonly !== null && execonly !== false && !e8.fileExecutableP(abs)) continue;
        found.push(file);
      }
    }
    return found;
  };
  return [start, end, names as unknown as e8.Value, ":exit-function", spaceAfter as unknown as e8.Value];
}

/** What completes the command before point, if it is the command of its part of the line, as shell-command-completion. */
e8.defun("shell-command-completion", () => {
  const word = matchPartialFilenameRaw();
  const filename = matchPartialFilename();
  if (word === undefined || filename === undefined || /[~/]/.test(filename)) return null;
  const commandStart = e8.saveExcursion(() => {
    backwardCommand(1);
    return e8.point();
  });
  return word.start === commandStart ? (commandCompletionData() as e8.Value) : null;
});

/** What completes the file name before point, if it is after the command, as shell-filename-completion. */
e8.defun("shell-filename-completion", () => {
  const opoint = e8.point();
  const beg = lineBeginningPosition();
  const after = e8.saveExcursion(() => {
    const sep = e8.reSearchBackward("[;|&]", { bound: beg, noerror: true });
    e8.gotoChar(sep === undefined ? beg : e8.matchEnd(0)!);
    return e8.reSearchForward("[^ \t][ \t]", { bound: opoint, noerror: true }) !== undefined;
  });
  return after ? e8.funcall(filenameCompletion) : null;
});

/** The shell variable before point, $ and braces included, and where it is, as shell-match-partial-variable. */
function matchPartialVariable(): { start: number; end: number; text: string } | undefined {
  return e8.saveExcursion(() => {
    if (e8.reSearchBackward("[^A-Za-z0-9_{(]", { noerror: true }) !== undefined) {
      if (!e8.lookingAt("\\$")) e8.gotoChar(e8.point() + 1);
    } else e8.gotoChar(e8.pointMin());
    if (e8.point() === e8.lineEndPosition() || e8.lookingAt("[^A-Za-z0-9_{($]")) return undefined;
    e8.lookingAt("\\$?[{(]?[A-Za-z0-9_]*[})]?");
    const start = e8.matchBeginning(0)!;
    const end = e8.matchEnd(0)!;
    return { start, end, text: e8.bufferSubstringNoProperties(start, end) };
  });
}

/**
 * What completes the environment variable before point, after a $, from
 * process-environment, with the closing brace and, for a directory, a
 * slash after it, as shell-environment-variable-completion.
 */
e8.defun("shell-environment-variable-completion", () => {
  const v = matchPartialVariable();
  if (v === undefined || !v.text.startsWith("$")) return null;
  const start = e8.saveExcursion(() => {
    e8.gotoChar(v.start);
    e8.lookingAt("\\$?[({]*");
    return e8.matchEnd(0)!;
  });
  const variables = ((e8.variable("process-environment") ?? []) as e8.Value[]).map((x) => String(x).replace(/=.*/s, ""));
  const before = start > e8.pointMin() ? e8.charAfter(start - 1) : undefined;
  const suffix = before === "{" ? "}" : before === "(" ? ")" : "";
  const exit = (s: string, status: string) => {
    if (status !== "sole" && status !== "finished") return;
    const value = e8.getenv(s);
    insertSuffix(suffix + (value !== undefined && e8.fileDirectoryP(comintDirectory(value)) ? "/" : ""));
  };
  return [start, v.end, variables, ":exit-function", exit as unknown as e8.Value];
});

/**
 * A function putting the directory of the stack a =N or =- before point
 * stands for in its place, as shell-c-a-p-replace-by-expanded-directory.
 */
e8.defun("shell-c-a-p-replace-by-expanded-directory", () => {
  const word = matchPartialFilenameRaw();
  if (word === undefined) return null;
  const stack = [String(e8.variable("default-directory") ?? "~/"), ...(dirstacks.get(e8.bufferName()) ?? [])];
  return e8.saveExcursion(() => {
    e8.gotoChar(word.start);
    let index: number | undefined;
    if (e8.lookingAt("=-/?")) index = stack.length - 1;
    else if (e8.lookingAt("=\\([0-9]+\\)/?")) index = Number(e8.bufferSubstringNoProperties(e8.matchBeginning(1)!, e8.matchEnd(1)!));
    if (index === undefined) return null;
    const start = e8.matchBeginning(0)!;
    const end = e8.matchEnd(0)!;
    const at = index;
    return () => {
      if (at >= stack.length) e8.signal("error", "Directory stack not that deep");
      const replacement = e8.fileNameAsDirectory(stack[at]!);
      e8.saveExcursion(() => {
        e8.gotoChar(start);
        e8.insert(replacement);
        e8.deleteRegion(e8.point(), e8.point() + (end - start));
      });
      e8.message(`Directory item: ${at}`);
      return true;
    };
  });
});

/** Sets up completion in a shell buffer, as shell-completion-vars. */
function completionVars(): void {
  for (const [local, from] of [
    ["comint-completion-fignore", "shell-completion-fignore"],
    ["comint-file-name-chars", "shell-file-name-chars"],
    ["comint-file-name-quote-list", "shell-file-name-quote-list"],
    ["comint-dynamic-complete-functions", "shell-dynamic-complete-functions"],
  ]) {
    e8.makeLocalVariable(local!);
    e8.setVariable(local!, e8.variable(from!) ?? null);
  }
  e8.makeLocalVariable("comint-file-name-prefix");
  e8.setVariable("comint-file-name-prefix", "");
}
e8.defun("shell-completion-vars", completionVars);

/** Puts an ANSI colour's face on text as text properties, as shell-apply-ansi-color. */
e8.defun("shell-apply-ansi-color", (beg: number, end: number, face: e8.Value) => {
  if (face === null || face === undefined || face === false) return;
  e8.putTextProperty(beg, end, "ansi-color-face", face);
  e8.putTextProperty(beg, end, "font-lock-face", face);
});

/** Puts the ANSI colours' faces back on the buffer's text, as shell-reapply-ansi-color. */
function reapplyAnsiColor(): void {
  e8.saveRestriction(() => {
    e8.widen();
    let pos = e8.pointMin();
    let end = e8.nextSinglePropertyChange(pos, "ansi-color-face") ?? e8.pointMax();
    for (;;) {
      const face = e8.getTextProperty(pos, "ansi-color-face");
      if (face !== null && face !== undefined) e8.putTextProperty(pos, end, "font-lock-face", face);
      const next = e8.nextSinglePropertyChange(end, "ansi-color-face");
      if (end >= e8.pointMax()) break;
      pos = end;
      end = next ?? e8.pointMax();
    }
  });
}
e8.defun("shell-reapply-ansi-color", reapplyAnsiColor);

/** Colours ANSI output with text properties, as shell-mode and shell-command-mode do. */
function textPropertyColours(): void {
  e8.makeLocalVariable("ansi-color-apply-face-function");
  e8.setVariable("ansi-color-apply-face-function", "shell-apply-ansi-color");
}

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
  bindings: {
    TAB: "completion-at-point",
    "M-?": "comint-dynamic-list-filename-completions",
    "C-c C-f": "shell-forward-command",
    "C-c C-b": "shell-backward-command",
  } as Record<string, e8.CommandName>,
  setup: () => {
    e8.makeLocalVariable("comint-prompt-regexp");
    e8.setVariable("comint-prompt-regexp", e8.variable("shell-prompt-pattern") ?? null);
    e8.makeLocalVariable("paragraph-start");
    e8.setVariable("paragraph-start", e8.variable("comint-prompt-regexp") ?? null);
    completionVars();
    textPropertyColours();
    reapplyAnsiColor();
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
      textPropertyColours();
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
