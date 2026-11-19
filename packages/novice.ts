// Disabled commands, after Emacs's novice.el: a command whose `disabled`
// property is set asks before it runs from a key or M-x, explaining what
// it does, and can be enabled for this time, for good, or with all the
// others for the session.

import { substituteCommandKeys } from "help-guide";
import { readMultipleChoice } from "rmc";
import { regexpQuote } from "subr";

e8.defineVariable({
  name: "disabled-command-function",
  doc: "Function to call to handle disabled commands.\nIf nil, the feature is disabled, i.e., all commands work normally.",
  value: "disabled-command-function",
});
e8.defineVariable({
  name: "user-init-file",
  doc: "The init file loaded at startup, init.ts in the configuration directory, or nil if none was, as with -q.",
  value: null,
});

// The commands Emacs 30 disables, as its files put them.
for (const command of ["downcase-region", "upcase-region", "narrow-to-region", "narrow-to-page", "scroll-left", "set-goal-column", "erase-buffer"]) {
  e8.put(command, "disabled", true);
}

/** The first paragraph of a command's documentation, each line indented three columns, as disabled-command-function shows it. */
function firstParagraph(command: string): string {
  const doc = (e8.documentation(command) ?? "<< not documented >>").split("\n\n")[0]!;
  return doc
    .split("\n")
    .map((line) => (line === "" ? line : `   ${line}`))
    .join("\n");
}

/**
 * Asks whether to run a disabled command, explaining why it is disabled,
 * and runs it unless told not to, as novice.el's disabled-command-function:
 * n not, y enabling it (in the init file too, if asked), SPC this once, !
 * enabling every disabled command for the session.
 */
e8.defun("disabled-command-function", (cmdIn?: string | symbol, keysIn?: string) => {
  const name = (v: unknown) => (typeof v === "symbol" ? (v.description ?? "") : String(v));
  const cmd = cmdIn !== undefined && cmdIn !== null ? name(cmdIn) : name(e8.thisCommand());
  const keys = keysIn ?? e8.thisCommandKeys();
  const prefix = e8.prefixArg();
  const why = e8.get(cmd, "disabled");
  const viaMx = keys === "M-x" || keys.startsWith("M-x ") || keys.startsWith("ESC x");
  const helpString =
    (viaMx
      ? `You have invoked the disabled command ${cmd}.\n`
      : substituteCommandKeys(`You have typed \\\`${keys}', invoking disabled command ${cmd}.\n`)) +
    (typeof why === "string"
      ? why
      : `It is disabled because new users often find it confusing.\n${substituteCommandKeys("Here's the first part of its description:\n\n")}${firstParagraph(cmd)}`) +
    substituteCommandKeys(
      "\n\nDo you want to use this command anyway?\n\nYou can now type:\n" +
        " \\`n'    (also C-g) to cancel--don't try the command; it remains disabled.\n" +
        " \\`y'    to enable the command (no questions if you use it again).\n" +
        " \\`SPC'  to try the command just this once, but leave it disabled.\n" +
        " \\`!'    to enable it and all the disabled commands for this session.",
    );
  const [answer] = readMultipleChoice(
    "Use this command?",
    [
      ["n", "no"],
      ["y", "yes"],
      ["SPC", "(space bar) only once"],
      ["!", "use and enable all"],
    ],
    helpString,
    "*Disabled Command*",
  );
  if (answer === "!") e8.setDefault("disabled-command-function", null);
  else if (answer === "y") {
    const init = e8.variable("user-init-file");
    if (typeof init === "string" && init !== "" && e8.yOrNP("Enable command for future editing sessions also? ")) enableCommand(cmd);
    else e8.put(cmd, "disabled", null);
  }
  if (answer !== "n") {
    // As call-interactively with the prefix argument the keys gave.
    e8.setPrefixArg(prefix);
    e8.callInteractively(cmd as e8.CommandName);
  }
});

/**
 * Enables or disables a command, now and in the init file, as
 * en/disable-command: its line there, `e8.put("NAME", "disabled", ...);`,
 * replaced or added at the end, and the file saved.
 */
function enOrDisableCommand(command: string, disable: boolean): void {
  if (!e8.commandp(command)) e8.signal("error", `Invalid command name \`${command}'`);
  e8.put(command, "disabled", disable ? true : null);
  let init = e8.variable("user-init-file");
  if (typeof init !== "string" || init === "") {
    const fallback = e8.expandFileName("init.ts", String(e8.variable("user-emacs-directory") ?? "~/.config/e8/"));
    // Started with -q: the file where commands are enabled was not read, and writing it would lose what it says.
    if (e8.fileExistsP(fallback)) e8.signal("error", 'Saving settings from "e8 -q" would overwrite existing customizations');
    init = fallback;
  }
  const buffer = e8.findFileNoselect(init);
  e8.withCurrentBuffer(buffer, () => {
    e8.gotoChar(e8.pointMin());
    if (e8.searchForwardRegexp(regexpQuote(`e8.put("${command}", "disabled", `), { noerror: true }) !== undefined) {
      e8.deleteRegion(e8.lineBeginningPosition(e8.point()), Math.min(e8.pointMax(), e8.lineEndPosition(e8.point()) + 1));
    }
    e8.gotoChar(e8.pointMax());
    if (e8.point() !== e8.lineBeginningPosition(e8.point())) e8.insert("\n");
    e8.insert(`e8.put("${command}", "disabled", ${disable ? "true" : "false"});\n`);
    e8.call("save-buffer");
  });
}

/** Enables a command, now and for later sessions, as enable-command. */
export const enableCommand = (command: string) => enOrDisableCommand(command, false);

e8.defineCommand({
  name: "enable-command",
  doc: "Allow COMMAND to be executed without special confirmation from now on.\nCOMMAND must be a symbol.\nThis command alters the user's init file so that this will apply\nto future sessions.",
  params: [{ name: "command", kind: "command", prompt: "Enable command: " }],
  run: (command: string) => enOrDisableCommand(command, false),
});

e8.defineCommand({
  name: "disable-command",
  doc: "Require special confirmation to execute COMMAND from now on.\nCOMMAND must be a symbol.\nThis command alters your init file so that this choice applies to\nfuture sessions.",
  params: [{ name: "command", kind: "command", prompt: "Disable command: " }],
  run: (command: string) => enOrDisableCommand(command, true),
});

