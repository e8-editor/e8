// Coding agents in a buffer, after Emacs's agent-shell
// (https://github.com/xenodium/agent-shell): M-x agent-shell starts an agent
// that speaks the Agent Client Protocol, such as Claude Code through
// claude-agent-acp, Gemini CLI or Codex, in the current project, and talks
// to it in an Org buffer, as E8's own agent buffer does (ADR 0019):
//
//   * You       what you ask, sent with C-c RET
//   * Agent     its reply as it streams in, its Markdown made Org a line
//               at a time; its thinking in a #+begin_thinking block; each
//               tool call a line, its output or diff in a src block named
//               by what it holds, folded into the line as it comes (TAB
//               shows it), and its plan as a checklist; Claude Code's own
//               bookkeeping calls left out (agent-shell-hidden-tools)
//
// The conversation above the request being typed is a transcript, as a
// shell's is: the agent's turns and the requests sent are read-only, and
// undo reaches only the request being typed. The session lives in the
// agent, which can take nothing back, so the buffer never says what the
// agent does not remember.
//
// The session starts as the buffer opens, and the header line shows its
// model, mode and thought level: C-c C-v picks the model, C-c C-t the
// thought level, C-c TAB the next mode and C-c C-s any setting the agent
// offers, from ACP's session config options or its older modes and models.
//
// The agent asks before its tools act, and E8 asks you, when nothing
// else is asking. It reads files through the buffers visiting them, so it
// sees what is not saved yet, and writes them through those buffers, an
// edit that undoes, then saves. C-c C-k stops the turn. Logging in is the
// agent's: log in with it in a terminal once, and E8 never sees a key
// (ADR 0061). The protocol is acp.ts's.
//
// This follows agent-shell's design, not its code: the buffer is E8's
// Org agent buffer, not shell-maker's.

import * as acp from "acp";
import { findBufferVisiting } from "files";
import { defineGuide, substituteCommandKeys } from "help-guide";
import { completionInRegion } from "minibuffer";
import { BLOCK_BEGIN, BLOCK_END, flag, folded, toggleDrawerOrBlock, withoutFoldChecks } from "org-fold";
import { current as projectRoot } from "project";
import { allMatches, charCount, executableFind, truthy } from "subr";

e8.defineVariable({
  name: "agent-shell-agents",
  value: [
    ["claude", ["claude-agent-acp"]],
    ["gemini", ["gemini", "--experimental-acp"]],
    ["codex", ["codex-acp"]],
    ["goose", ["goose", "acp"]],
  ],
  doc:
    "The agents M-x agent-shell can start: a list of [name, command], or [name, command, environment], the command a " +
    'program and its arguments that speak the Agent Client Protocol, and the environment "VAR=value" strings. ' +
    "Claude Code's is claude-agent-acp: npm install -g @agentclientprotocol/claude-agent-acp.",
});
e8.defineVariable({
  name: "agent-shell-e8-tools",
  value: true,
  doc:
    "Whether agents also get E8's own tools, its commands, keys and buffers, through e8-mcp connected to this " +
    "editor, as an MCP server of their session. Writing files, discarding unsaved work, quitting and running code " +
    "through them ask you first. Needs this E8 to answer on a socket (e8-mcp-socket) and e8-mcp beside " +
    "it or on PATH.",
});
e8.defineVariable({
  name: "agent-shell-hidden-tools",
  value: ["ToolSearch", "TodoWrite"],
  doc:
    "The tools, by the name the agent gives them, whose calls the buffer leaves out: Claude Code's own bookkeeping, " +
    "finding its tools and keeping its to-do list, which shows as the plan.",
});
e8.defineVariable({
  name: "agent-shell-default-agent",
  value: null,
  doc: "The agent M-x agent-shell starts without asking, by its name in agent-shell-agents; null to ask.",
});

e8.defineVariable({
  name: "agent-shell-session-strategy",
  value: "prompt",
  doc:
    "What M-x agent-shell does about the agent's earlier sessions in the project, when it can list and load them: " +
    '"prompt" asks whether to resume one or start a new session, "latest" resumes the most recent one, and "new" ' +
    "always starts a new session. A resumed session's conversation is replayed into the buffer, and the agent " +
    "remembers it.",
});
e8.defineVariable({
  name: "agent-shell-history",
  value: [],
  doc:
    "The requests sent to agents, newest first, for M-p, M-n and M-r in every agent-shell buffer. Savehist mode " +
    "saves it between sessions, as it does the minibuffer's histories.",
});
e8.defineVariable({
  name: "agent-shell-history-size",
  value: 500,
  doc: "How many requests agent-shell-history keeps.",
});
// Kept between sessions with the minibuffer's histories, when savehist-mode is on.
{
  const saved = e8.variable("savehist-additional-variables");
  if (Array.isArray(saved) && !saved.includes("agent-shell-history")) {
    e8.setDefault("savehist-additional-variables", [...saved, "agent-shell-history"]);
  }
}

/** The most of a tool call's output the buffer shows. */
const SHOWN_OUTPUT = 4000;

// A region the buffer keeps up to date, a tool call's or the plan's, lies
// between two markers: its start advances past text put in at it, so
// rewriting a region before it leaves it where it is, and its end does
// not, so text put in after it is not taken into it.

/** A tool call as the buffer shows it, kept up to date as the agent reports. */
interface ToolCall {
  title: string;
  status: string;
  /** The tool's own name, as Claude Code's adapter gives it, and what it was called with. */
  toolName?: string;
  input?: { [key: string]: unknown };
  /** What it does, as ACP's kinds: read, edit, execute and the rest. */
  kind?: string;
  /** The language its output's src block is named with, where its content says. */
  lang?: string;
  /** Whether its block is folded into its line: at first, and until TAB opens it. */
  folded: boolean;
  /** Whether it is one of agent-shell-hidden-tools, which the buffer leaves out. */
  hidden: boolean;
  /** The files it names, by its diffs and locations. */
  paths: Set<string>;
  /** Its text, rendered: the line and its block. */
  content: string;
  /** Where its line starts, and where its block ends. */
  start: e8.Marker;
  end: e8.Marker;
}

/** A question the agent asked, waiting for the user. */
interface Permission {
  id: number | string;
  title: string;
  toolCallId?: string;
  options: { optionId: string; name: string; kind: string }[];
}

interface Shell {
  agent: string;
  command: string[];
  env: string[];
  buffer: string;
  directory: string;
  client: acp.Client;
  sessionId?: string;
  /** Whether a turn is going: from sending until the agent answers the prompt. */
  busy: boolean;
  /** Whether C-c C-k stopped the turn while it was starting. */
  cancelled: boolean;
  /** What is open at the buffer's end: the agent's text, its thinking in a block, or nothing. */
  open: "text" | "thought" | "request" | undefined;
  /** The agent's text since its last full line, shown as it came, and where it starts. */
  partial: string;
  partialAt?: e8.Marker;
  /** Where the agent's Markdown is: in a code block or not. */
  markdown: MarkdownState;
  toolCalls: Map<string, ToolCall>;
  plan?: { start: e8.Marker; end: e8.Marker };
  /** Where the thinking being written starts, its #+begin_thinking line. */
  thought?: e8.Marker;
  permissions: Permission[];
  asking: boolean;
  askTimer?: number;
  usage?: { used: number; size: number };
  /** The session's settings, its mode and model among them, as the agent offers them. */
  options: SessionOption[];
  /** Whether its agent and session are starting, and what waits for them. */
  starting: boolean;
  waiting: { ready: () => void; failed: (error: acp.RpcError) => void }[];
  /** The end of what the agent wrote to standard error, for when it fails. */
  stderrTail: string;
  /** What the agent can do with its earlier sessions, as its initialize answer says. */
  canLoad: boolean;
  canList: boolean;
  canResume: boolean;
  /** The session the agent had when it stopped, resumed when it starts again if it can. */
  lastSessionId?: string;
  /** Whether a session being loaded is replaying its conversation into the buffer. */
  loading: boolean;
  /** The agent's slash commands, as its available_commands_update gives them. */
  commands: SlashCommand[];
  /** Where M-p and M-n are in the history, or undefined at the request being typed. */
  historyIndex: number | undefined;
  /** What was typed before M-p, put back when M-n comes past the newest. */
  historyStored: string | undefined;
}

const shells = new Map<string, Shell>();

/** One of a setting's values. */
interface OptionValue {
  value: string;
  name: string;
  description?: string;
}

/**
 * A setting of the session, as ACP's session config options give them:
 * its mode, model and thought level, and whatever else the agent offers.
 * An agent that gives only the older modes or models has them here too,
 * set with session/set_mode or session/set_model.
 */
interface SessionOption {
  id: string;
  name: string;
  category?: string;
  description?: string;
  current: string;
  values: OptionValue[];
  via?: "set_mode" | "set_model";
}

// What C-h h shows in an agent's buffer (ADR 0068).
defineGuide("agent-shell-mode", {
  title: "Agent shell",
  summary:
    "A conversation with a coding agent, kept as Org. Type a request under the last * You heading and send it; " +
    "the reply streams in below, and the agent asks before its tools change anything.",
  keys: [
    [
      "Talking",
      [
        ["agent-shell-send", "Send the request you typed"],
        ["agent-shell-interrupt", "Stop the agent's turn"],
        ["agent-shell-previous-input", "Bring back the request before; again for older ones"],
        ["agent-shell-search-history", "Pick an earlier request by searching"],
      ],
    ],
    [
      "The session",
      [
        ["agent-shell-cycle-session-mode", "Next mode, such as asking before edits or planning"],
        ["agent-shell-set-session-model", "Choose the model"],
        ["agent-shell-set-session-thought-level", "Choose how hard it thinks"],
      ],
    ],
    ["Reading the reply", [["org-cycle", "On a tool call or thinking: show or fold what it holds"]]],
  ],
  tryNow: [
    "Ask about the project you are in, such as \"What does this project do?\", and press \\[agent-shell-send].",
    "Type / at the start of a request and \\[completion-at-point] for the agent's slash commands.",
  ],
  learnNext: [
    "The header line shows the model, mode and thought level; the mode line, how full the context is.",
    "In the conversation above the prompt, n and p move between headings, as Org's speed keys.",
    "\\[describe-mode] lists every key of the agent shell.",
  ],
});

e8.defineMajorMode({
  name: "agent-shell-mode",
  modeName: "Agent Shell",
  parent: "org-mode",
  doc:
    "The mode of a conversation with a coding agent, started with M-x agent-shell.\n\n" +
    "Type a request under the last * You heading and send it with C-c RET. The agent's reply streams in under " +
    "* Agent, its Markdown made Org; each tool call is a line, with its output or diff folded into it as it comes " +
    "(TAB on the line shows it, and a call the agent asks about shows its diff while it asks); its thinking is a #+begin_thinking block, folded as it comes, which TAB on its first line opens as any Org block. " +
    "The tools agent-shell-hidden-tools names are left out. The conversation above the request you are typing is " +
    "read-only, as a shell's: the agent's turns and the requests sent, which undo never reaches. M-p and M-n bring " +
    "the requests sent before back to the prompt, as in a shell, and M-r picks one of them. A request starting " +
    "with / is one of the agent's slash commands, which TAB or C-M-i completes, its description shown once it is whole. In the transcript, where " +
    "nothing can be typed, Org's speed commands run anywhere: n and p move to the next and previous heading, f and b " +
    "to the next and previous at the same level, u up, c and C fold and unfold, o opens a link and ? lists them. The agent asks before its tools act. C-c C-k stops the turn. The mode " +
    "line shows whether the agent is working and how much of its context the conversation fills.\n\n" +
    "The header line shows the session's model, mode and thought level, and nothing else: the keys are listed below. " +
    "C-c TAB, or C-<tab> as in Emacs's " +
    "agent-shell where tab-bar-mode does not take it, moves to the next mode, C-c C-v " +
    "picks the model, C-c C-t the thought level, and C-c C-s any setting the agent offers. Picking a mode is " +
    "M-x agent-shell-set-session-mode, as C-c C-m is C-c RET.",
  bindings: {
    "C-c RET": "agent-shell-send",
    "C-c C-k": "agent-shell-interrupt",
    "C-<tab>": "agent-shell-cycle-session-mode",
    "C-c TAB": "agent-shell-cycle-session-mode",
    "C-c C-v": "agent-shell-set-session-model",
    "C-c C-t": "agent-shell-set-session-thought-level",
    "C-c C-s": "agent-shell-set-session-config-option",
    "M-p": "agent-shell-previous-input",
    "M-n": "agent-shell-next-input",
    "M-r": "agent-shell-search-history",
    "C-<up>": "agent-shell-previous-input",
    "C-<down>": "agent-shell-next-input",
  },
  setup: () => {
    e8.call("visual-line-mode");
    // Agents' tools, e8-mcp's included, act in other windows than this one.
    e8.setVariable("agent-buffer", true);
    // The session's settings, once it has started; until then, an empty line, so the text does not move.
    e8.setVariable("header-line-format", " ");
    // ~code~ and *bold* without their markers, as a chat shows them.
    e8.makeLocalVariable("org-hide-emphasis-markers");
    e8.setVariable("org-hide-emphasis-markers", true);
    e8.addHook("org-cycle-tab-first-hook", toggleBlockBelow, { local: true });
    // TAB after a / at the start of the request completes the agent's slash commands, as C-M-i does.
    e8.addHook("org-cycle-tab-first-hook", completeSlashCommand, { local: true });
    e8.addHook("completion-at-point-functions", slashCompletions, { local: true });
    // Letters in the transcript, where typing is refused, move about it instead.
    e8.makeLocalVariable("org-use-speed-commands");
    e8.setVariable("org-use-speed-commands", inTranscript);
    e8.makeLocalVariable("org-speed-commands");
    e8.setVariable("org-speed-commands", SPEED_COMMANDS);
  },
});

/** Whether point is in the transcript, the read-only text above the request being typed. */
function inTranscript(): boolean {
  return e8.point() < e8.bufferSize() && e8.getTextProperty(e8.point(), "read-only") === true;
}

/**
 * The speed commands of the transcript: Org's that move about and fold,
 * not those that edit, which the transcript refuses.
 */
const SPEED_COMMANDS: e8.Value = [
  ["Outline Navigation"],
  ["n", ["org-speed-move-safe", "org-next-visible-heading"]],
  ["p", ["org-speed-move-safe", "org-previous-visible-heading"]],
  ["f", ["org-speed-move-safe", "org-forward-heading-same-level"]],
  ["b", ["org-speed-move-safe", "org-backward-heading-same-level"]],
  ["u", ["org-speed-move-safe", "outline-up-heading"]],
  ["Outline Visibility"],
  ["c", "org-cycle"],
  ["C", "org-shifttab"],
  ["Misc"],
  ["o", "org-open-at-point"],
  ["?", "org-speed-command-help"],
];

/**
 * The header line: the session's model, mode and thought level, as state,
 * never the keys, which C-h m lists, as a shell's header says nothing of its keys.
 */
function showSettings(shell: Shell): void {
  const shown = ["model", "mode", "thought_level"]
    .map((category) => shell.options.find((o) => o.category === category))
    .filter((o): o is SessionOption => o !== undefined)
    .map((o) => valueName(o, o.current));
  const head = shell.starting ? ` Starting ${shell.agent}…` : shown.length > 0 ? ` ${shown.join(" · ")}` : "";
  inBuffer(shell, () => e8.setVariable("header-line-format", `${head === "" ? " " : head}`.replace(/%/g, "%%")));
}

/** Positions as a line start and its end, and the line's text. */
function lineAround(pos: number): { start: number; end: number; text: string } {
  const start = e8.lineBeginningPosition(pos);
  const end = e8.lineEndPosition(pos);
  return { start, end, text: e8.bufferText(start, end) };
}

/**
 * The block under a tool call's line, the line at `pos`: from that line's
 * end to its block's #+end line's end, which is what folds into the line.
 */
function blockBelow(pos: number): [number, number] | undefined {
  const line = lineAround(pos);
  if (!line.text.startsWith("→ ") || line.end >= e8.bufferSize()) return undefined;
  let next = lineAround(line.end + 1);
  const begin = BLOCK_BEGIN.exec(next.text);
  if (!begin) return undefined;
  const name = begin[1].toLowerCase();
  while (next.end < e8.bufferSize()) {
    next = lineAround(next.end + 1);
    const end = BLOCK_END.exec(next.text);
    if (end && end[1].toLowerCase() === name) return [line.end, next.end];
  }
  return undefined;
}

/** Folds or shows the block under the line at `pos`, if it has one, or folds it when `hide` says so. */
function foldBlockBelow(pos: number, hide?: boolean): boolean {
  const block = blockBelow(pos);
  if (block === undefined) return false;
  flag(block[0], block[1], hide ?? !folded(block[0], "org-hide-block"), "org-hide-block");
  return true;
}

/** TAB on a tool call's line: shows the block folded into it, or folds it. A block's own first line is Org's. */
function toggleBlockBelow(): boolean {
  if (!foldBlockBelow(e8.point())) return false;
  // Remembered, so the call's next update keeps it so.
  const shell = shells.get(e8.bufferName() ?? "");
  if (shell !== undefined) {
    const line = e8.lineBeginningPosition();
    const shown = !folded(e8.lineEndPosition(), "org-hide-block");
    for (const call of shell.toolCalls.values()) if (e8.markerPosition(call.start) === line) call.folded = !shown;
  }
  return true;
}

// --- The buffer -----------------------------------------------------------------

/** Runs `fn` in the shell's buffer, if it is still there. */
function inBuffer<T>(shell: Shell, fn: () => T): T | undefined {
  if (e8.getBuffer(shell.buffer) === undefined) return undefined;
  return e8.withCurrentBuffer(shell.buffer, fn);
}

/**
 * Runs `fn` in the shell's buffer as the agent writing it: read-only text
 * gives way, nothing is recorded for undo, as a shell's output is not, and
 * Org's checks of the folds near a change stand aside, as they do for its
 * own code's edits, since the agent writes into a block still folding.
 */
function writing<T>(shell: Shell, fn: () => T): T | undefined {
  return inBuffer(shell, () => withoutFoldChecks(() => e8.letBind({ "inhibit-read-only": true, "buffer-undo-list": true }, fn)));
}

/** Makes text the transcript's: read-only, from its first character on, so nothing is typed before it either. */
function lock(start: number, end: number): void {
  if (end <= start) return;
  e8.putTextProperty(start, end, "read-only", true);
  e8.putTextProperty(start, end, "front-sticky", ["read-only"]);
}

/**
 * A * You heading for the next request, typed after it: the heading is the
 * transcript's, and typing after its newline is allowed, as after a shell's prompt.
 */
function putPrompt(shell: Shell, before = ""): void {
  const text = `${before}* You\n`;
  const at = put(shell, text);
  writing(shell, () => e8.putTextProperty(at + text.length - 1, at + text.length, "rear-nonsticky", ["read-only"]));
}

/**
 * Puts text in the shell's buffer at `at`, its end by default, keeping
 * point and the windows that were at the end there, as output follows in a
 * shell. Returns where it went.
 */
function put(shell: Shell, text: string, at?: number): number {
  return (
    writing(shell, () => {
      const end = e8.bufferSize();
      const where = at ?? end;
      const point = e8.point();
      const following = e8.windowList().filter((w) => e8.windowBuffer(w) === shell.buffer && e8.windowPoint(w) === end);
      e8.gotoChar(where);
      e8.insert(text);
      lock(where, where + text.length);
      const after = point === end || point > where ? point + text.length : point;
      e8.gotoChar(point === end ? e8.bufferSize() : after);
      for (const w of following) {
        if (w !== e8.selectedWindow()) e8.setWindowPoint(w, e8.bufferSize());
      }
      return where;
    }) ?? 0
  );
}

/** Replaces the text from `start` to `end` in the shell's buffer, keeping point after it where it was. */
function replace(shell: Shell, start: number, end: number, text: string): void {
  writing(shell, () => {
    const point = e8.point();
    e8.deleteRegion(start, end);
    e8.gotoChar(start);
    e8.insert(text);
    lock(start, start + text.length);
    const moved = point >= end ? point - (end - start) + text.length : Math.min(point, start + text.length);
    e8.gotoChar(moved);
  });
}

function atLineStart(shell: Shell): boolean {
  return inBuffer(shell, () => e8.bufferSize() === 0 || e8.bufferText(e8.bufferSize() - 1, e8.bufferSize()) === "\n") ?? true;
}

/** Ends the buffer's last line, if it is not ended. */
function startLine(shell: Shell): void {
  if (!atLineStart(shell)) put(shell, "\n");
}

/**
 * The agent's text as it streams in: each full line made Org from
 * Markdown, and the line still coming shown as it is until its end comes.
 */
function putReply(shell: Shell, text: string): void {
  const lines = (shell.partial + text).split("\n");
  const rest = lines.pop()!;
  const done = lines.map((l) => `${markdownLineToOrg(l, shell.markdown)}\n`).join("");
  replacePartial(shell, done, rest);
}

/** Replaces the line still coming with `done`, and `rest` as the line still coming after it. */
function replacePartial(shell: Shell, done: string, rest: string): void {
  const end = inBuffer(shell, () => e8.bufferSize()) ?? 0;
  const at = shell.partialAt === undefined ? end : Math.min(e8.markerPosition(shell.partialAt) ?? end, end);
  if (at < end) writing(shell, () => e8.deleteRegion(at, end));
  // Shown as it came, but never as a heading or a block's line meanwhile.
  const shown = /^\s*(\*|#\+)/.test(rest) ? ` ${rest}` : rest;
  put(shell, done + shown);
  if (shell.partialAt === undefined) shell.partialAt = e8.makeMarker(at + done.length, { buffer: shell.buffer });
  else e8.setMarker(shell.partialAt, at + done.length, shell.buffer);
  shell.partial = rest;
}

/** Ends the agent's text: the line still coming made Org, and a code block it left open closed. */
function flushReply(shell: Shell): void {
  let done = shell.partial === "" ? "" : `${markdownLineToOrg(shell.partial, shell.markdown)}\n`;
  if (shell.markdown.fence !== undefined) done += `${shell.markdown.indent ?? ""}#+end_${shell.markdown.block}\n`;
  if (done !== "" || shell.partialAt !== undefined) replacePartial(shell, done, "");
  shell.markdown = {};
  if (shell.partialAt !== undefined) e8.deleteMarker(shell.partialAt);
  shell.partialAt = undefined;
}

// --- Markdown --------------------------------------------------------------------

/** Where a Markdown reply is, from one line to the next: in a fenced code block, or not. */
export interface MarkdownState {
  /** The fence that opened the code block, ``` or ~~~, which a fence at least as long closes. */
  fence?: string;
  /** The Org block it became, src or example, and how far it is indented. */
  block?: "src" | "example";
  indent?: string;
}

/**
 * A line of Markdown as Org, as gptel converts its replies in Org buffers:
 * fenced code a src block, headings bold lines (Org's headings are the
 * conversation's), * and + bullets -, emphasis, code and links in Org's
 * markup, and table rules Org's.
 */
export function markdownLineToOrg(line: string, state: MarkdownState): string {
  if (state.fence !== undefined) {
    const close = /^(\s*)(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[2][0] === state.fence[0] && close[2].length >= state.fence.length) {
      const end = `${state.indent ?? ""}#+end_${state.block}`;
      state.fence = undefined;
      return end;
    }
    return escapeCode(line);
  }
  const open = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/.exec(line);
  if (open) {
    state.fence = open[2];
    state.indent = open[1];
    state.block = open[3] === "" ? "example" : "src";
    return open[3] === "" ? `${open[1]}#+begin_example` : `${open[1]}#+begin_src ${open[3]}`;
  }
  const heading = /^ {0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/.exec(line);
  if (heading) {
    const title = inlineMarkdownToOrg(heading[1].replace(/\*\*|__/g, "")).trim();
    return title === "" ? "" : `*${title}*`;
  }
  if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) return "-----";
  if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) {
    const indent = /^\s*/.exec(line)![0];
    const cells = line.trim().slice(1, -1).split("|").map((c) => "-".repeat(Math.max(c.length, 1)));
    return `${indent}|${cells.join("+")}|`;
  }
  const bullet = /^(\s*)[*+](\s+)(.*)$/.exec(line);
  const org = bullet ? `${bullet[1]}-${bullet[2]}${inlineMarkdownToOrg(bullet[3])}` : inlineMarkdownToOrg(line);
  // What is left that Org would read as a heading or a block's line.
  return /^(\*+\s|\s*#\+)/.test(org) ? ` ${org}` : org;
}

/** Code in Org's markup: ~code~, or =code= when it holds a ~, or as it came when it holds both. */
function orgCode(code: string): string {
  const c = code.trim();
  if (c === "") return code;
  if (!c.includes("~")) return `~${c}~`;
  if (!c.includes("=")) return `=${c}=`;
  return `\`${code}\``;
}

/** A line's code spans, links, emphasis and strike-through as Org's. */
export function inlineMarkdownToOrg(text: string): string {
  // What is made Org is kept aside, so nothing later matches inside it.
  const kept: string[] = [];
  const keep = (org: string) => `\u0000${kept.push(org) - 1}\u0000`;
  let out = text.replace(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_m, _ticks, code) => keep(orgCode(code)));
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, _alt, url) => keep(`[[${url}]]`));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, url) => keep(`[[${url}][${emphasis(label)}]]`));
  out = out.replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url) => keep(`[[${url}]]`));
  out = emphasis(out);
  for (let i = 0; i < 3 && out.includes("\u0000"); i++) out = out.replace(/\u0000(\d+)\u0000/g, (_m, n) => kept[Number(n)]);
  return out;
}

/** **bold** and __bold__ as *bold*, *italic* and _italic_ as /italic/, ~~struck~~ as +struck+. */
function emphasis(text: string): string {
  const kept: string[] = [];
  const keep = (org: string) => `\u0001${kept.push(org) - 1}\u0001`;
  const italic = (t: string) =>
    t
      .replace(/(?<![\w*\\])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "/$1/")
      .replace(/(?<![\w\\])_(?=\S)([^_]*?\S)_(?!\w)/g, "/$1/");
  let out = text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_m, t) => keep(`*${italic(t)}*`))
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, (_m, t) => keep(`*${italic(t)}*`))
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_m, t) => keep(`+${t}+`));
  out = italic(out);
  return out.replace(/\u0001(\d+)\u0001/g, (_m, n) => kept[Number(n)]);
}

/** A line of code as Org keeps it in a block: a comma before what would read as a heading or a block's end, as org-escape-code-in-region. */
function escapeCode(line: string): string {
  return line.replace(/^(\s*)(,*(\*|#\+))/, "$1,$2");
}

/** Text in a src block named by its language, diff, console, json or text, its lines escaped so none ends the block. */
function srcBlock(lang: string, text: string, label = ""): string {
  let shown = [...text].slice(0, SHOWN_OUTPUT).join("");
  if ([...text].length > SHOWN_OUTPUT) shown += "…";
  const lines = shown.replace(/\n$/, "").split("\n").map(escapeCode);
  return `#+begin_src ${lang}\n${label}${lines.join("\n")}\n#+end_src\n`;
}

/** Closes what is open at the end: the agent's paragraph, or its thinking's block. */
function closeOpen(shell: Shell): void {
  if (shell.open === "thought") {
    flushReply(shell);
    startLine(shell);
    const begin = shell.thought && e8.markerPosition(shell.thought);
    const hidden = begin === undefined || (inBuffer(shell, () => folded(e8.lineEndPosition(begin), "org-hide-block")) ?? true);
    put(shell, "#+end_thinking\n");
    // Folded as Org folds a block, from its first line, so TAB there opens it.
    if (begin !== undefined) inBuffer(shell, () => toggleDrawerOrBlock(e8.lineOf(begin), hidden));
    if (shell.thought) e8.deleteMarker(shell.thought);
    shell.thought = undefined;
  } else if (shell.open === "text") {
    flushReply(shell);
    startLine(shell);
  } else if (shell.open === "request") {
    startLine(shell);
    put(shell, "\n* Agent\n");
  }
  shell.open = undefined;
}

/** A note in brackets on a line of its own. */
function note(shell: Shell, text: string): void {
  closeOpen(shell);
  startLine(shell);
  put(shell, `[${text}]\n`);
}

// --- Tool calls, plans and diffs --------------------------------------------------

/** Old and new text as lines taken out and put in, the lines both share at the ends left out. */
export function diffLines(path: string, oldText: string | null | undefined, newText: string): string {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines = [`--- ${path}`, `+++ ${path}`, `@@ line ${start + 1} @@`];
  for (const l of a.slice(start, endA)) lines.push(`-${l}`);
  for (const l of b.slice(start, endB)) lines.push(`+${l}`);
  return lines.join("\n");
}

/** Text that is one Markdown code fence, as Claude Code's adapter wraps a command's output: what it fences, and the language it names. */
function unfenced(text: string): { text: string; lang?: string } | undefined {
  const m = /^\s*(`{3,}|~{3,})[ \t]*(\S*)[^\n]*\n([\s\S]*?)\n?[ \t]*\1\s*$/.exec(text);
  return m ? { text: m[3], lang: m[2] === "" ? undefined : m[2] } : undefined;
}

/**
 * What a tool call's content shows: its text, diffs and terminals, one
 * after another, with the language that names its block: diff for a diff,
 * else what a fence around its text says.
 */
function toolContent(content: unknown): { text: string; lang?: string } {
  if (!Array.isArray(content)) return { text: "" };
  const parts: string[] = [];
  let lang: string | undefined;
  for (const c of content) {
    if (c?.type === "content" && c.content?.type === "text") {
      const text = String(c.content.text ?? "");
      const fenced = unfenced(text);
      parts.push(fenced ? fenced.text : text);
      if (lang === undefined && fenced?.lang !== undefined) lang = fenced.lang;
    } else if (c?.type === "content" && c.content?.type === "resource_link") parts.push(String(c.content.uri ?? c.content.name ?? ""));
    else if (c?.type === "diff") {
      parts.push(diffLines(String(c.path ?? ""), c.oldText, String(c.newText ?? "")));
      lang = "diff";
    } else if (c?.type === "terminal") parts.push(`[terminal ${c.terminalId}]`);
  }
  return { text: parts.filter((p) => p !== "").join("\n"), lang };
}

const STATUS: { [status: string]: string } = { pending: " …", in_progress: " …", completed: "", failed: " (failed)" };

/**
 * A tool call's title as Org code, ~title~, or =title= when it holds a ~,
 * so a shell command's slashes and pluses are not read as Org's emphasis;
 * as it is when it holds both.
 */
function quoteTitle(title: string): string {
  const t = title.replace(/\n/g, " ").replace(/`/g, "").trim();
  if (t === "") return title;
  if (!t.includes("~")) return `~${t}~`;
  if (!t.includes("=")) return `=${t}=`;
  return t;
}

/** A value of a tool's input, short. */
function shortValue(v: unknown): string {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * What a tool call's line names: its title, an MCP tool's mcp__SERVER__TOOL
 * as "SERVER: TOOL" with what it was called with, the project's directory
 * left out of paths and the home directory as ~.
 */
function toolTitle(shell: Shell, call: ToolCall): string {
  let title = call.title;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(call.toolName ?? call.title);
  if (mcp) {
    const args = Object.entries(call.input ?? {})
      .map(([k, v]) => `${k}=${shortValue(v)}`)
      .join(" ");
    title = `${mcp[1]}: ${mcp[2]}${args ? ` ${args}` : ""}`;
    if (title.length > 100) title = `${title.slice(0, 99)}…`;
  }
  const dir = shell.directory.replace(/\/+$/, "");
  const home = e8.expandFileName("~").replace(/\/+$/, "");
  if (dir !== "") title = title.split(`${dir}/`).join("").split(dir).join(".");
  if (home !== "") title = title.split(`${home}/`).join("~/");
  return title;
}

function renderToolCall(shell: Shell, call: ToolCall): string {
  if (call.hidden) return "";
  // A command's description, as Claude Code's Bash tool gives one, after it.
  const description = typeof call.input?.description === "string" ? ` — ${call.input.description.replace(/\n/g, " ")}` : "";
  const line = `→ ${quoteTitle(toolTitle(shell, call))}${STATUS[call.status] ?? ""}${description}\n`;
  // Named by what it holds: a diff, a command's output, JSON, or text.
  const lang = call.lang ?? (call.kind === "execute" ? "console" : "text");
  return call.content === "" ? line : line + srcBlock(lang, call.content, call.status === "failed" ? "Failed:\n" : "");
}

/** Shows a tool call, or brings one shown up to date. */
function showToolCall(shell: Shell, update: acp.Json, first: boolean): void {
  const id = String(update.toolCallId ?? "");
  let call = shell.toolCalls.get(id);
  if (call === undefined) {
    closeOpen(shell);
    startLine(shell);
    const at = inBuffer(shell, () => e8.bufferSize()) ?? 0;
    const toolName = update._meta?.claudeCode?.toolName ? String(update._meta.claudeCode.toolName) : undefined;
    const hiddenTools = e8.variable("agent-shell-hidden-tools");
    call = {
      title: String(update.title ?? update.kind ?? "tool"),
      status: String(update.status ?? "pending"),
      toolName,
      kind: update.kind ? String(update.kind) : undefined,
      folded: true,
      hidden: toolName !== undefined && Array.isArray(hiddenTools) && hiddenTools.includes(toolName),
      content: "",
      paths: new Set(),
      start: e8.makeMarker(at, { buffer: shell.buffer, advances: true }),
      end: e8.makeMarker(at, { buffer: shell.buffer }),
    };
    shell.toolCalls.set(id, call);
  } else if (first) {
    return;
  }
  if (update.title) call.title = String(update.title);
  if (update.rawInput && typeof update.rawInput === "object" && Object.keys(update.rawInput).length > 0) call.input = update.rawInput;
  const finished = update.status && update.status !== call.status && (update.status === "completed" || update.status === "failed");
  if (update.status) call.status = String(update.status);
  for (const c of Array.isArray(update.content) ? update.content : []) if (c?.type === "diff" && c.path) call.paths.add(String(c.path));
  for (const l of Array.isArray(update.locations) ? update.locations : []) if (l?.path) call.paths.add(String(l.path));
  if (update.content !== undefined && update.content !== null) {
    const shown = toolContent(update.content);
    call.content = shown.text;
    call.lang = shown.lang;
  } else if (update.rawOutput !== undefined && call.content === "" && (call.status === "completed" || call.status === "failed")) {
    if (typeof update.rawOutput === "string") {
      const fenced = unfenced(update.rawOutput);
      call.content = fenced ? fenced.text : update.rawOutput;
      call.lang = fenced?.lang;
    } else {
      call.content = JSON.stringify(update.rawOutput, null, 2);
      call.lang = "json";
    }
  }
  const start = e8.markerPosition(call.start) ?? 0;
  const end = e8.markerPosition(call.end) ?? start;
  const text = renderToolCall(shell, call);
  replace(shell, start, end, text);
  e8.setMarker(call.start, start, shell.buffer);
  e8.setMarker(call.end, start + text.length, shell.buffer);
  // Its output folds into its line as it comes, unless TAB opened it.
  if (text !== "" && call.content !== "") inBuffer(shell, () => foldBlockBelow(start, call.folded));
  if (finished) revertTouched(call.paths);
}

/**
 * Brings the buffers visiting files a tool call touched up to date, where
 * the agent wrote them itself rather than through fs/write_text_file, as
 * Claude Code's adapter does: a buffer with no unsaved changes whose file
 * changed is reverted, as auto-revert-mode would; one with changes is left
 * for the user.
 */
function revertTouched(paths: Set<string>): void {
  for (const path of paths) {
    const buffer = findBufferVisiting(path);
    if (buffer === undefined) continue;
    e8.withCurrentBuffer(buffer, () => {
      if (!e8.bufferModified() && e8.visitedFileChanged() && e8.fileExists(path)) e8.call("revert-buffer-quick");
    });
  }
}

const PLAN_MARK: { [status: string]: string } = { pending: "[ ]", in_progress: "[-]", completed: "[X]" };

/** Shows the agent's plan as a checklist, replacing the plan it showed before in this turn. */
function showPlan(shell: Shell, entries: unknown): void {
  if (!Array.isArray(entries)) return;
  const text = `Plan:\n${entries.map((e) => `- ${PLAN_MARK[e?.status] ?? "[ ]"} ${String(e?.content ?? "").replace(/\n/g, " ")}`).join("\n")}\n`;
  if (shell.plan === undefined) {
    closeOpen(shell);
    startLine(shell);
    const at = put(shell, text);
    shell.plan = { start: e8.makeMarker(at, { buffer: shell.buffer, advances: true }), end: e8.makeMarker(at + text.length, { buffer: shell.buffer }) };
    return;
  }
  const start = e8.markerPosition(shell.plan.start) ?? 0;
  const end = e8.markerPosition(shell.plan.end) ?? start;
  replace(shell, start, end, text);
  e8.setMarker(shell.plan.end, start + text.length, shell.buffer);
}

/** Takes in what the agent reports of its session. */
function onUpdate(shell: Shell, notification: acp.Json): void {
  if (notification.method !== "session/update") return;
  const params = notification.params ?? {};
  if (shell.sessionId !== undefined && params.sessionId !== shell.sessionId) return;
  const update = params.update ?? {};
  // A replayed request is followed by what the agent did with it, under its own heading.
  if (shell.open === "request" && REPLIED.includes(update.sessionUpdate)) closeOpen(shell);
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      // A request of a session being loaded, replayed; otherwise the echo of one sent here.
      if (shell.loading && update.content?.type === "text") {
        if (shell.open !== "request") {
          closeOpen(shell);
          startLine(shell);
          put(shell, `${inBuffer(shell, () => e8.bufferSize()) ? "\n" : ""}* You\n`);
          shell.open = "request";
        }
        put(shell, String(update.content.text ?? ""));
      }
      break;
    case "agent_message_chunk":
      if (update.content?.type === "text") {
        if (shell.open === "thought") closeOpen(shell);
        if (shell.open === undefined) startLine(shell);
        shell.open = "text";
        putReply(shell, String(update.content.text ?? ""));
      }
      break;
    case "agent_thought_chunk":
      if (update.content?.type === "text") {
        let first = false;
        if (shell.open !== "thought") {
          closeOpen(shell);
          startLine(shell);
          const at = put(shell, "#+begin_thinking\n");
          shell.thought = e8.makeMarker(at, { buffer: shell.buffer, advances: true });
          shell.open = "thought";
          first = true;
        }
        // Its Markdown made Org as the reply's is: the block is Org, not verbatim.
        putReply(shell, String(update.content.text ?? ""));
        // Folded from its first line as it comes, as Org folds a block, unless TAB opened it.
        const begin = shell.thought && e8.markerPosition(shell.thought);
        if (begin !== undefined) {
          inBuffer(shell, () => {
            const from = e8.lineEndPosition(begin);
            if (first || folded(from, "org-hide-block")) flag(from, e8.bufferSize(), true, "org-hide-block");
          });
        }
      }
      break;
    case "tool_call":
      showToolCall(shell, update, true);
      break;
    case "tool_call_update":
      showToolCall(shell, update, false);
      break;
    case "plan":
      showPlan(shell, update.entries);
      break;
    case "usage_update":
      if (typeof update.used === "number") {
        shell.usage = { used: update.used, size: Number(update.size ?? 0) };
        showState(shell);
      }
      break;
    case "current_mode_update":
      if (update.currentModeId) {
        const mode = shell.options.find((o) => o.category === "mode");
        if (mode) mode.current = String(update.currentModeId);
        showSettings(shell);
      }
      break;
    case "config_option_update":
      takeOptions(shell, update.configOptions);
      break;
    case "available_commands_update":
      if (Array.isArray(update.availableCommands)) {
        shell.commands = update.availableCommands
          .filter((c: any) => typeof c?.name === "string" && c.name !== "")
          .map((c: any) => ({
            name: String(c.name),
            description: typeof c.description === "string" ? c.description : "",
            hint: typeof c.input?.hint === "string" ? c.input.hint : undefined,
          }));
      }
      break;
    default:
      // session_info_update and the rest.
      break;
  }
}

/** The updates that are the agent's reply to a request. */
const REPLIED = ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"];

// --- What the agent asks -------------------------------------------------------------

/** "Edit `src/main.rs`" as "edit src/main.rs", for "Let claude ...?". */
function lowerFirst(title: string): string {
  const t = title.replace(/`/g, "");
  return t.length > 1 && t[1] === t[1].toLowerCase() ? t[0].toLowerCase() + t.slice(1) : t;
}

/** The keys a permission question takes, and the option each picks: y once, ! always, n no. */
function choices(options: Permission["options"]): Map<string, string> {
  const pick = (...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find((o) => o !== undefined)?.optionId;
  const keys = new Map<string, string>();
  const once = pick("allow_once", "allow_always");
  const always = pick("allow_always");
  const no = pick("reject_once", "reject_always");
  if (once) keys.set("y", once);
  if (always && always !== once) keys.set("!", always);
  if (no) keys.set("n", no);
  return keys;
}

/**
 * Asks the user the agent's permission questions, one at a time, once
 * nothing else waits for their keys: never inside another question, so the
 * agent can neither answer for the user nor take keys meant for something
 * else. Until then it looks again shortly.
 */
function askPermissions(shell: Shell): void {
  shell.askTimer = undefined;
  if (shell.asking || shell.permissions.length === 0) return;
  if (e8.waitingForInput() !== undefined) {
    shell.askTimer = e8.runWithTimer(0.1, null, () => askPermissions(shell));
    return;
  }
  const permission = shell.permissions[0];
  const keys = choices(permission.options);
  const listed = [...keys.keys()].map((k) => (k === "!" ? "! for always" : k)).join(", ").replace(/, ([^,]*)$/, " or $1");
  shell.asking = true;
  // What it asks about, its diff most often, shows while it asks.
  const call = permission.toolCallId === undefined ? undefined : shell.toolCalls.get(permission.toolCallId);
  const at = call && call.content !== "" ? e8.markerPosition(call.start) : undefined;
  if (at !== undefined) inBuffer(shell, () => foldBlockBelow(at, false));
  let answer: string | undefined;
  try {
    answer = e8.readCharChoice(`Let ${shell.agent} ${lowerFirst(permission.title)}? (${listed}) `, [...keys.keys()].join(""));
  } catch {
    answer = undefined;
  } finally {
    shell.asking = false;
    const back = call && e8.markerPosition(call.start);
    if (call && back !== undefined && call.content !== "") inBuffer(shell, () => foldBlockBelow(back, call.folded));
  }
  // C-c C-k may have answered it meanwhile.
  if (shell.permissions[0] !== permission) return;
  shell.permissions.shift();
  const optionId = answer === undefined ? undefined : keys.get(answer);
  const chosen = permission.options.find((o) => o.optionId === optionId);
  note(shell, chosen ? `${chosen.name}: ${permission.title}` : `Cancelled: ${permission.title}`);
  acp.sendResponse({
    client: shell.client,
    response: acp.makeSessionRequestPermissionResponse({ requestId: permission.id, ...(optionId ? { optionId } : { cancelled: true }) }),
  });
  if (shell.permissions.length > 0) shell.askTimer = e8.runWithTimer(0, null, () => askPermissions(shell));
}

/** Answers every question still waiting as cancelled, as the turn stopped. */
function cancelPermissions(shell: Shell): void {
  for (const p of shell.permissions.splice(0)) {
    acp.sendResponse({ client: shell.client, response: acp.makeSessionRequestPermissionResponse({ requestId: p.id, cancelled: true }) });
  }
  if (shell.askTimer !== undefined) e8.cancelTimer(shell.askTimer);
  shell.askTimer = undefined;
}

/** A file's lines from `line`, 1-based, at most `limit` of them. */
function someLines(text: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return text;
  const lines = text.split("\n");
  const from = Math.max(0, (line ?? 1) - 1);
  return lines.slice(from, limit === undefined ? undefined : from + limit).join("\n");
}

/** What a file holds: the text of the buffer visiting it, saved or not, or the file's. */
function readText(path: string): string {
  const visiting = findBufferVisiting(path);
  if (visiting !== undefined) return e8.withCurrentBuffer(visiting, () => e8.bufferText(0, e8.bufferSize()));
  if (!e8.fileReadableP(path)) e8.signal("file-missing", `Opening input file: No such file or directory, ${path}`);
  const temp = e8.getBufferCreate(" *agent-shell-read*");
  try {
    return e8.withCurrentBuffer(temp, () => {
      e8.deleteRegion(0, e8.bufferSize());
      e8.insertFileContents(path);
      return e8.bufferText(0, e8.bufferSize());
    });
  } finally {
    e8.call("kill-buffer", temp.name!);
  }
}

/**
 * Writes a file through the buffer visiting it, or one made to visit it:
 * its text replaced, an edit that undoes, point kept at its line and
 * column, then saved.
 */
function writeText(path: string, content: string): void {
  const dir = e8.fileNameDirectory(path);
  if (dir && !e8.fileExistsP(dir)) e8.makeDirectory(dir, { parents: true });
  const buffer = findBufferVisiting(path) ?? e8.findFileNoselect(path);
  e8.withCurrentBuffer(buffer, () => {
    if (e8.bufferText(0, e8.bufferSize()) !== content) {
      const point = e8.point();
      const before = e8.bufferText(0, point);
      const line = before.split("\n").length - 1;
      const column = point - (before.lastIndexOf("\n") + 1);
      e8.deleteRegion(0, e8.bufferSize());
      e8.insert(content);
      const lines = content.split("\n");
      const row = Math.min(line, lines.length - 1);
      let at = 0;
      for (let i = 0; i < row; i++) at += lines[i].length + 1;
      e8.gotoChar(at + Math.min(column, lines[row].length));
    }
    e8.call("save-buffer");
  });
}

/** Answers what the agent asks of the editor. */
function onRequest(shell: Shell, request: acp.Json): void {
  const params = request.params ?? {};
  const fail = (e: unknown) => acp.makeError({ code: -32603, message: e instanceof Error ? e.message : String((e as any)?.message ?? e) });
  switch (request.method) {
    case "session/request_permission":
      shell.permissions.push({
        id: request.id,
        title: String(params.toolCall?.title ?? params.toolCall?.kind ?? "use a tool"),
        toolCallId: params.toolCall?.toolCallId ? String(params.toolCall.toolCallId) : undefined,
        options: Array.isArray(params.options) ? params.options : [],
      });
      if (params.toolCall?.toolCallId) showToolCall(shell, params.toolCall, !shell.toolCalls.has(String(params.toolCall.toolCallId)));
      // Asked from a timer of its own, so the agent's updates go on coming in meanwhile.
      if (shell.askTimer === undefined && !shell.asking) shell.askTimer = e8.runWithTimer(0, null, () => askPermissions(shell));
      break;
    case "fs/read_text_file": {
      let response: acp.Response;
      try {
        const line = typeof params.line === "number" ? params.line : undefined;
        const limit = typeof params.limit === "number" ? params.limit : undefined;
        response = acp.makeFsReadTextFileResponse({ requestId: request.id, content: someLines(readText(String(params.path)), line, limit) });
      } catch (e) {
        response = acp.makeFsReadTextFileResponse({ requestId: request.id, error: fail(e) });
      }
      acp.sendResponse({ client: shell.client, response });
      break;
    }
    case "fs/write_text_file": {
      let response: acp.Response;
      try {
        writeText(String(params.path), String(params.content ?? ""));
        response = acp.makeFsWriteTextFileResponse({ requestId: request.id });
      } catch (e) {
        response = acp.makeFsWriteTextFileResponse({ requestId: request.id, error: fail(e) });
      }
      acp.sendResponse({ client: shell.client, response });
      break;
    }
    default:
      acp.sendResponse({
        client: shell.client,
        response: { requestId: request.id, error: acp.makeError({ code: -32601, message: `Method not found: ${request.method}` }) as unknown as acp.Json },
      });
  }
}

// --- Sessions and turns --------------------------------------------------------------

function makeShellClient(shell: Shell): acp.Client {
  const client = acp.makeClient({ command: shell.command[0], commandParams: shell.command.slice(1), environmentVariables: shell.env, contextBuffer: shell.buffer });
  acp.subscribeToNotifications({ client, onNotification: (n) => onUpdate(shell, n) });
  acp.subscribeToRequests({ client, onRequest: (r) => onRequest(shell, r) });
  acp.subscribeToErrors({
    client,
    onError: (e: any) => {
      if (typeof e?.code === "number" && e.code === -32603) {
        shell.stderrTail = (shell.stderrTail + String(e.message ?? "")).slice(-2000);
      } else {
        // An API error the agent reported, parsed.
        note(shell, `${shell.agent}: ${String(e?.message ?? JSON.stringify(e))}`);
      }
    },
  });
  return client;
}

/** How to log in to an agent: Claude Code's adapter uses claude's own login. */
function loginHint(shell: Shell): string {
  if (shell.command.some((part) => part.includes("claude-agent-acp"))) return "run claude in a terminal and log in there (/login)";
  return `log in with ${shell.command.find((p) => !p.startsWith("-") && p !== "npx") ?? shell.command[0]} in a terminal`;
}

/** What an error the agent answered with says, with what it wrote to standard error if it stopped. */
function describe(shell: Shell, error: acp.RpcError | undefined): string {
  const message = String(error?.message ?? "failed");
  if (error?.code === -32000 || /auth/i.test(message)) {
    return `${shell.agent} needs you to log in: ${loginHint(shell)}, then send again (${message})`;
  }
  const tail = shell.stderrTail.trim();
  return tail !== "" && message.startsWith("Agent process ended") ? `${message}\n${tail.split("\n").slice(-5).join("\n")}` : message;
}

/** A count of tokens, short: 950, 46k, 1M or 1.5M. */
function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

/** Shows on the mode line whether the agent is working and how much of its context the conversation fills. */
function showState(shell: Shell): void {
  const usage = shell.usage && shell.usage.size > 0 ? ` ${tokens(shell.usage.used)}/${tokens(shell.usage.size)}` : "";
  inBuffer(shell, () => e8.setVariable("mode-line-process", `${shell.busy ? ":working" : ""}${usage}`));
}

/** Ends the turn: a note if it did not end as asked, its blocks folded, and a heading for the next request. */
function finish(shell: Shell, text?: string): void {
  shell.busy = false;
  shell.cancelled = false;
  showState(shell);
  cancelPermissions(shell);
  closeOpen(shell);
  if (text) note(shell, text);
  startLine(shell);
  putPrompt(shell, "\n");
  forgetTurn(shell);
}

/** Lets go of what a turn kept track of: its tool calls and its plan. */
function forgetTurn(shell: Shell): void {
  for (const call of shell.toolCalls.values()) {
    e8.deleteMarker(call.start);
    e8.deleteMarker(call.end);
  }
  shell.toolCalls.clear();
  if (shell.plan) {
    e8.deleteMarker(shell.plan.start);
    e8.deleteMarker(shell.plan.end);
    shell.plan = undefined;
  }
}

/**
 * E8's own MCP server for a session: e8-mcp, beside this program
 * or on PATH, connected to this editor's socket, so the agent's calls act in
 * the editor the user sees and ask before what they cannot undo. Undefined
 * when agent-shell-e8-tools is off or either is missing.
 */
export function e8McpServer(): acp.Json | undefined {
  if (!truthy(e8.variable("agent-shell-e8-tools"))) return undefined;
  const socket = e8.variable("e8-mcp-socket");
  if (typeof socket !== "string" || socket === "") return undefined;
  const dir = e8.variable("invocation-directory");
  const beside = typeof dir === "string" ? `${dir}e8-mcp` : undefined;
  const program = beside !== undefined && e8.fileExecutableP(beside) ? beside : executableFind("e8-mcp");
  if (program === undefined) return undefined;
  return { name: "e8", command: program, args: ["--socket", socket], env: [] };
}

/** What the agent is told of E8's tools, after its own system prompt. */
const E8_TOOLS_PROMPT =
  "You are running inside E8, a text editor that works the way Emacs works, and the user is talking to you " +
  "from it. The e8 MCP server's tools act in that editor, in the window the user works in: its commands by " +
  "name (find-file, save-buffer, org-agenda and the rest), keys, and the text of its buffers, unsaved changes " +
  "included. Use them to show the user what you are working on, or when they ask for something in the editor. " +
  "Writing files, discarding unsaved changes, quitting and running code through them wait for the user's approval; " +
  "if a call's result says the user allowed it, make the same call again.";

// --- The session's settings -----------------------------------------------------------

/** A setting's values, those in groups taken out of them. */
function optionValues(options: unknown): OptionValue[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((o: any): OptionValue[] =>
    Array.isArray(o?.options)
      ? optionValues(o.options)
      : o?.value === undefined
        ? []
        : [{ value: String(o.value), name: String(o.name ?? o.value), description: o.description ? String(o.description) : undefined }],
  );
}

/** The settings ACP's configOptions give, those with values to pick from. */
function configOptions(list: unknown): SessionOption[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((o: any) => o?.id !== undefined && (o.type === undefined || o.type === "select"))
    .map((o: any) => ({
      id: String(o.id),
      name: String(o.name ?? o.id),
      category: o.category ? String(o.category) : undefined,
      description: o.description ? String(o.description) : undefined,
      current: String(o.currentValue ?? ""),
      values: optionValues(o.options),
    }));
}

/** Takes the settings a session/new answer gives: its configOptions, else its modes and models. */
function sessionOptions(result: any): SessionOption[] {
  const options = configOptions(result?.configOptions);
  const modes = result?.modes;
  if (!options.some((o) => o.category === "mode") && Array.isArray(modes?.availableModes)) {
    options.push({
      id: "mode",
      name: "Mode",
      category: "mode",
      current: String(modes.currentModeId ?? ""),
      values: modes.availableModes.map((m: any) => ({ value: String(m.id), name: String(m.name ?? m.id), description: m.description ? String(m.description) : undefined })),
      via: "set_mode",
    });
  }
  const models = result?.models;
  if (!options.some((o) => o.category === "model") && Array.isArray(models?.availableModels)) {
    options.push({
      id: "model",
      name: "Model",
      category: "model",
      current: String(models.currentModelId ?? ""),
      values: models.availableModels.map((m: any) => ({ value: String(m.modelId), name: String(m.name ?? m.modelId), description: m.description ? String(m.description) : undefined })),
      via: "set_model",
    });
  }
  return options;
}

/** Replaces the settings with those the agent reports, keeping the older modes and models where nothing new stands for them. */
function takeOptions(shell: Shell, list: unknown): void {
  if (!Array.isArray(list)) return;
  const fresh = configOptions(list);
  const older = shell.options.filter((o) => o.via !== undefined && !fresh.some((f) => f.category === o.category));
  shell.options = [...fresh, ...older];
  showSettings(shell);
}

/** A value's name, or the value when the setting does not list it. */
function valueName(option: SessionOption, value: string): string {
  return option.values.find((v) => v.value === value)?.name ?? value;
}

/** The value a name or a value means, as a user picks it by name and code by either. */
function valueNamed(option: SessionOption, answer: string): string | undefined {
  const a = answer.trim();
  return (option.values.find((v) => v.name === a) ?? option.values.find((v) => v.value === a) ?? option.values.find((v) => v.name.toLowerCase() === a.toLowerCase()))?.value;
}

/** The setting named, by its name, id or category. */
function optionNamed(shell: Shell, answer: string): SessionOption | undefined {
  const a = answer.trim().toLowerCase();
  return shell.options.find((o) => o.name.toLowerCase() === a || o.id.toLowerCase() === a || o.category === a);
}

/** Sets a setting of the session, saying what it became. */
function setOption(shell: Shell, option: SessionOption, value: string): void {
  if (shell.sessionId === undefined || !acp.clientStartedP(shell.client)) e8.userError(`${shell.agent} has no session yet`);
  const sessionId = shell.sessionId!;
  const request =
    option.via === "set_mode"
      ? acp.makeSessionSetModeRequest({ sessionId, modeId: value })
      : option.via === "set_model"
        ? acp.makeSessionSetModelRequest({ sessionId, modelId: value })
        : acp.makeSessionSetConfigOptionRequest({ sessionId, configId: option.id, value });
  acp.sendRequest({
    client: shell.client,
    request,
    onSuccess: (result: any) => {
      if (Array.isArray(result?.configOptions)) takeOptions(shell, result.configOptions);
      else {
        option.current = value;
        showSettings(shell);
      }
      e8.message(`${option.name}: ${valueName(option, value)}`);
    },
    onFailure: (error: acp.RpcError) => e8.message(`Could not set ${option.name.toLowerCase()}: ${String(error?.message ?? "failed")}`),
  });
}

/** The shell of the current buffer, if it is one, for the settings' completions. */
function shellHere(): Shell | undefined {
  return shells.get(e8.bufferName() ?? "");
}

/** The setting of a category in the current shell, or an error saying the agent has none. */
function optionOf(category: string, what: string): [Shell, SessionOption] {
  const shell = currentShell();
  const option = shell.options.find((o) => o.category === category);
  if (option === undefined) e8.userError(shell.starting ? `${shell.agent} is still starting` : `${shell.agent} offers no ${what} to pick`);
  return [shell, option!];
}

/** A command that picks the value of the current shell's setting of a category. */
function defineSetter(name: string, category: string, what: string, doc: string): void {
  const label = what[0].toUpperCase() + what.slice(1);
  e8.defineCommand({
    name,
    doc,
    params: [
      {
        name: what,
        // Worked out before it asks, so an agent with nothing to pick says so first.
        prompt: () => {
          const [, option] = optionOf(category, what);
          return `${label} (${valueName(option, option.current)}): `;
        },
        collection: () => shellHere()?.options.find((o) => o.category === category)?.values.map((v) => v.name) ?? [],
        requireMatch: true,
      },
    ],
    run: (answer: string) => {
      const [shell, option] = optionOf(category, what);
      const value = valueNamed(option, answer);
      if (value === undefined) e8.userError(`${shell.agent} has no ${what} ${answer}`);
      setOption(shell, option, value!);
    },
  });
}

defineSetter(
  "agent-shell-set-session-mode",
  "mode",
  "mode",
  "Set the agent's mode for this session, as its agent offers them: Claude Code's Manual, Accept edits, Plan, Auto and Bypass permissions.",
);
defineSetter("agent-shell-set-session-model", "model", "model", "Set the model the agent uses in this session, of those it offers.");
defineSetter(
  "agent-shell-set-session-thought-level",
  "thought_level",
  "thought level",
  "Set how hard the agent thinks in this session, of the levels it offers: Claude Code's effort, low to max.",
);

e8.defineCommand({
  name: "agent-shell-cycle-session-mode",
  doc: "Move the agent to its next mode, after the one it is in, back to the first after the last.",
  run: () => {
    const [shell, option] = optionOf("mode", "mode");
    const at = option.values.findIndex((v) => v.value === option.current);
    const next = option.values[(at + 1) % option.values.length];
    if (next === undefined) e8.userError(`${shell.agent} offers no mode to pick`);
    setOption(shell, option, next.value);
  },
});

e8.defineCommand({
  name: "agent-shell-set-session-config-option",
  doc: "Set any of the settings the agent offers for this session, its mode, model and thought level among them: the setting, then its value.",
  params: [
    { name: "option", prompt: "Setting: ", collection: () => shellHere()?.options.map((o) => o.name) ?? [], requireMatch: true },
    {
      name: "value",
      prompt: (option: string) => {
        const o = shellHere() && optionNamed(shellHere()!, option);
        return o ? `${o.name} (${valueName(o, o.current)}): ` : `${option}: `;
      },
      collection: (option: string) => {
        const shell = shellHere();
        return (shell && optionNamed(shell, option)?.values.map((v) => v.name)) ?? [];
      },
      requireMatch: true,
    },
  ],
  run: (name: string, answer: string) => {
    const shell = currentShell();
    const option = optionNamed(shell, name);
    if (option === undefined) e8.userError(`${shell.agent} has no setting ${name}`);
    const value = valueNamed(option!, answer);
    if (value === undefined) e8.userError(`${option!.name} has no value ${answer}`);
    setOption(shell, option!, value!);
  },
});

// --- Sessions and turns, continued -------------------------------------------------------

/**
 * Starts the agent and a session in the project, if it has none running,
 * then calls `ready`; `failed` if either fails. A shell starts its session
 * when it opens, so its settings can be picked before the first request,
 * and again when a request finds its agent stopped.
 */
function startSession(shell: Shell, ready: () => void, failed: (error: acp.RpcError) => void): void {
  if (shell.sessionId !== undefined && acp.clientStartedP(shell.client)) return ready();
  shell.waiting.push({ ready, failed });
  if (shell.starting) return;
  // An agent that stopped: start it again, in a new session.
  if (shell.sessionId !== undefined) {
    acp.shutdown({ client: shell.client });
    shell.client = makeShellClient(shell);
    shell.lastSessionId = shell.sessionId;
    shell.sessionId = undefined;
    shell.options = [];
  }
  shell.starting = true;
  shell.stderrTail = "";
  showSettings(shell);
  const done = (error?: acp.RpcError) => {
    shell.starting = false;
    showSettings(shell);
    for (const w of shell.waiting.splice(0)) {
      if (error === undefined) w.ready();
      else w.failed(error);
    }
  };
  try {
    acp.sendRequest({
      client: shell.client,
      request: acp.makeInitializeRequest({
        protocolVersion: 1,
        clientInfo: { name: "e8", title: "E8", version: String(e8.variable("e8-version") ?? "") },
        readTextFileCapability: true,
        writeTextFileCapability: true,
      }),
      onSuccess: (result: any) => {
        const capabilities = result?.agentCapabilities ?? {};
        shell.canLoad = capabilities.loadSession === true;
        shell.canList = typeof capabilities.sessionCapabilities?.list === "object";
        shell.canResume = typeof capabilities.sessionCapabilities?.resume === "object";
        openSession(shell, done);
      },
      onFailure: done,
    });
  } catch (e) {
    // Its program is not installed, most likely.
    const message = e instanceof Error ? e.message : String((e as any)?.message ?? e);
    const hint = shell.command.some((p) => p.includes("claude-agent-acp")) ? "; npm install -g @agentclientprotocol/claude-agent-acp installs it" : "";
    done({ code: -32603, message: `${message}${hint}` } as acp.RpcError);
  }
}

/**
 * Opens the shell's session once its agent has started: the one it had, if
 * the agent stopped and can resume it; else one of its earlier sessions in
 * the project, as agent-shell-session-strategy says, its conversation
 * replayed into the buffer; else a new one.
 */
function openSession(shell: Shell, done: (error?: acp.RpcError) => void): void {
  const server = e8McpServer();
  const mcpServers = server ? [server] : [];
  const meta = server ? { systemPrompt: { append: E8_TOOLS_PROMPT } } : undefined;
  const opened = (result: any, sessionId: string) => {
    shell.sessionId = sessionId;
    shell.options = sessionOptions(result);
    done();
  };
  const fresh = (): void => {
    acp.sendRequest({
      client: shell.client,
      request: acp.makeSessionNewRequest({ cwd: shell.directory, mcpServers, ...(meta ? { meta } : {}) }),
      onSuccess: (result: any) => opened(result, String(result?.sessionId ?? "")),
      onFailure: done,
    });
  };
  const previous = shell.lastSessionId;
  shell.lastSessionId = undefined;
  if (previous !== undefined) {
    if (!shell.canResume) {
      note(shell, `Starting ${shell.agent} again, in a new session.`);
      return fresh();
    }
    note(shell, `Starting ${shell.agent} again, in the same session.`);
    acp.sendRequest({
      client: shell.client,
      request: acp.makeSessionResumeRequest({ sessionId: previous, cwd: shell.directory, mcpServers, ...(meta ? { meta } : {}) }),
      onSuccess: (result: any) => opened(result, previous),
      onFailure: () => {
        note(shell, `${shell.agent} could not resume it; a new session.`);
        fresh();
      },
    });
    return;
  }
  const strategy = e8.variable("agent-shell-session-strategy");
  if (strategy === "new" || !shell.canLoad || !shell.canList) return fresh();
  acp.sendRequest({
    client: shell.client,
    request: acp.makeSessionListRequest({ cwd: shell.directory }),
    onSuccess: (result: any) => {
      const sessions: EarlierSession[] = (Array.isArray(result?.sessions) ? result.sessions : [])
        .filter((s: any) => typeof s?.sessionId === "string")
        .map((s: any) => ({ sessionId: s.sessionId, title: typeof s.title === "string" ? s.title : "", updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "" }));
      if (sessions.length === 0) return fresh();
      if (strategy === "latest") return loadSession(shell, sessions[0], mcpServers, meta, opened, done);
      chooseSession(shell, sessions, (chosen) => (chosen ? loadSession(shell, chosen, mcpServers, meta, opened, done) : fresh()));
    },
    onFailure: () => fresh(),
  });
}

/** One of the agent's earlier sessions, as session/list gives them. */
interface EarlierSession {
  sessionId: string;
  title: string;
  updatedAt: string;
}

/** When a session was last used, as "2026-11-08 12:58", in local time. */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The choice that starts a new session rather than resuming one. */
const NEW_SESSION = "New session";

/**
 * Asks which earlier session to resume, or a new one, once nothing else
 * waits for keys, as permission questions are asked; C-g starts a new one.
 */
function chooseSession(shell: Shell, sessions: EarlierSession[], then: (chosen: EarlierSession | undefined) => void): void {
  if (e8.waitingForInput() !== undefined || shell.asking) {
    e8.runWithTimer(0.1, null, () => chooseSession(shell, sessions, then));
    return;
  }
  const labels = new Map<string, EarlierSession>();
  for (const session of sessions) {
    const base = [session.title.replace(/\s+/g, " ").trim() || session.sessionId, when(session.updatedAt)].filter((x) => x !== "").join(" · ");
    let label = base;
    for (let n = 2; labels.has(label); n++) label = `${base} (${n})`;
    labels.set(label, session);
  }
  let answer: string | undefined;
  shell.asking = true;
  try {
    answer = e8.completingRead(`Resume a session of ${shell.agent}: `, [NEW_SESSION, ...labels.keys()], { requireMatch: true });
  } catch {
    answer = undefined;
  } finally {
    shell.asking = false;
  }
  then(answer === undefined ? undefined : labels.get(answer));
}

/**
 * Loads an earlier session: the agent replays its conversation, which goes
 * in as the transcript, its requests under * You and its replies under
 * * Agent, above the request being typed, which waits meanwhile.
 */
function loadSession(
  shell: Shell,
  session: EarlierSession,
  mcpServers: acp.Json[],
  meta: acp.Json | undefined,
  opened: (result: any, sessionId: string) => void,
  done: (error?: acp.RpcError) => void,
): void {
  const typed = inBuffer(shell, () => e8.bufferText(requestStart(), e8.bufferSize())) ?? "";
  writing(shell, () => e8.deleteRegion(0, e8.bufferSize()));
  shell.loading = true;
  const ended = () => {
    shell.loading = false;
    closeOpen(shell);
    forgetTurn(shell);
    startLine(shell);
    // The earlier turns folded, as Org shows a heading's children, so the last is where it opens.
    inBuffer(shell, foldEarlierReplies);
    putPrompt(shell, inBuffer(shell, () => e8.bufferSize()) ? "\n" : "");
    inBuffer(shell, () => {
      e8.gotoChar(e8.bufferSize());
      e8.insert(typed);
      e8.setVariable("buffer-undo-list", null);
    });
  };
  acp.sendRequest({
    client: shell.client,
    request: acp.makeSessionLoadRequest({ sessionId: session.sessionId, cwd: shell.directory, mcpServers, ...(meta ? { meta } : {}) }),
    onSuccess: (result: any) => {
      ended();
      e8.message(`Resumed ${session.title || session.sessionId}`);
      opened(result, session.sessionId);
    },
    onFailure: (error: acp.RpcError) => {
      ended();
      note(shell, `Could not resume ${session.title || session.sessionId}: ${describe(shell, error)}`);
      done(error);
    },
  });
}

/** Sends the prompt, starting the agent and its session first if need be. */
function prompt(shell: Shell, text: string): void {
  const failed = (error: acp.RpcError) => finish(shell, `Error: ${describe(shell, error)}`);
  startSession(
    shell,
    () => {
      if (shell.cancelled) return finish(shell, "Stopped.");
      acp.sendRequest({
        client: shell.client,
        request: acp.makeSessionPromptRequest({ sessionId: shell.sessionId!, prompt: [{ type: "text", text }] }),
        onSuccess: (result: any) => {
          const reason = String(result?.stopReason ?? "end_turn");
          const notes: { [reason: string]: string } = {
            cancelled: "Stopped.",
            max_tokens: "The agent reached its most tokens for a reply.",
            max_turn_requests: "The agent reached its most requests for a turn.",
            refusal: "The agent declined.",
          };
          finish(shell, notes[reason]);
        },
        onFailure: failed,
      });
    },
    failed,
  );
}

/** The agents agent-shell-agents names, as [name, command, environment]. */
function agents(): [string, string[], string[]][] {
  const list = e8.variable("agent-shell-agents");
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is e8.Value[] => Array.isArray(a) && typeof a[0] === "string" && Array.isArray(a[1]))
    .map((a) => [String(a[0]), (a[1] as e8.Value[]).map(String), Array.isArray(a[2]) ? (a[2] as e8.Value[]).map(String) : []]);
}

/** Opens a conversation with an agent, by its name in agent-shell-agents, in another window. */
export function start(name: string): string {
  const agent = agents().find((a) => a[0] === name);
  if (agent === undefined) e8.userError(`No agent named ${name} in agent-shell-agents`);
  // The project's root, or the directory of the buffer it was started from.
  const directory = e8.expandFileName(projectRoot() ?? ".");
  const buffer = `*agent-shell: ${name}*`;
  const exists = e8.getBuffer(buffer) !== undefined && shells.has(buffer);
  e8.call("pop-to-buffer", buffer);
  if (!exists) {
    e8.call("agent-shell-mode");
    e8.makeLocalVariable("default-directory");
    e8.setVariable("default-directory", e8.fileNameAsDirectory(directory));
    const shell: Shell = {
      agent: name,
      command: agent![1],
      env: agent![2],
      buffer,
      directory,
      client: undefined as unknown as acp.Client,
      busy: false,
      cancelled: false,
      open: undefined,
      partial: "",
      markdown: {},
      toolCalls: new Map(),
      permissions: [],
      asking: false,
      stderrTail: "",
      canLoad: false,
      canList: false,
      canResume: false,
      loading: false,
      commands: [],
      historyIndex: undefined,
      historyStored: undefined,
      options: [],
      starting: false,
      waiting: [],
    };
    putPrompt(shell);
    e8.setBufferModified(false);
    shell.client = makeShellClient(shell);
    shells.set(buffer, shell);
    // Once, in the echo area, as with-editor's "Type C-c C-c to finish", while help-guide-mode is on (ADR 0068): the header line keeps to the settings.
    if (e8.variable("help-guide-mode") === true) {
      e8.message(substituteCommandKeys("Type a request under * You and send it with \\[agent-shell-send]; \\[help-guide-here] for help here", "agent-shell-mode"));
    }
    // Started now, so its settings can be picked before the first request;
    // if it fails, the first request says why, starting it again.
    startSession(shell, () => {}, (error) => e8.message(`${name}: ${describe(shell, error)}`));
  }
  return buffer;
}

e8.defineCommand({
  name: "agent-shell",
  doc:
    "Talk to a coding agent in a buffer of its own, in another window: one of agent-shell-agents, asked for unless " +
    "agent-shell-default-agent names one. Type a request under * You and send it with C-c RET. The agent works in " +
    "the current project, and asks before its tools act. When the agent has earlier sessions in the project, it " +
    "asks whether to resume one, its conversation replayed into the buffer, as agent-shell-session-strategy says.",
  run: async () => {
    const preset = e8.variable("agent-shell-default-agent");
    const name =
      typeof preset === "string" && preset !== ""
        ? preset
        : await e8.completingRead("Agent: ", agents().map((a) => a[0]), { requireMatch: true });
    start(name);
  },
});

e8.defineCommand({
  name: "agent-shell-anthropic-start-claude-code",
  doc: "Talk to Claude Code, through claude-agent-acp, in a buffer of its own: M-x agent-shell with the claude agent.",
  run: () => {
    start("claude");
  },
});

/** The shell of the current buffer, or an error saying it is not one. */
function currentShell(): Shell {
  const shell = shells.get(e8.bufferName() ?? "");
  if (shell === undefined) e8.userError("Not an agent shell; use M-x agent-shell");
  return shell!;
}

/** Where the request being typed starts: after the last * You heading, or undefined without one. */
function promptStart(): number | undefined {
  const text = e8.bufferText(0, e8.bufferSize());
  // The heading, at a line's start, not text in a line or a deeper heading.
  const after = text.lastIndexOf("\n* You\n");
  const at = after >= 0 ? after + 1 : text.startsWith("* You\n") ? 0 : -1;
  return at < 0 ? undefined : [...text.slice(0, at + "* You\n".length)].length;
}

/** Where the request being typed starts, or an error without a * You heading. */
function requestStart(): number {
  const start = promptStart();
  if (start === undefined) e8.userError("Type a request under a * You heading");
  return start!;
}

/** Folds each * Agent heading's reply but the last, as the replay of a long session leaves them. */
function foldEarlierReplies(): void {
  const text = e8.bufferText(0, e8.bufferSize());
  const headings: number[] = [];
  for (const m of allMatches(/^\* /gm, text)) headings.push(m.index);
  const replies = headings.filter((at) => text.startsWith("* Agent\n", at));
  const toChars = (i: number) => charCount(text.slice(0, i));
  for (const at of replies.slice(0, -1)) {
    const next = headings.find((h) => h > at);
    const lineEnd = text.indexOf("\n", at);
    // From the heading's end to the newline before the next heading, as outline hides a subtree.
    if (next !== undefined && next - 1 > lineEnd) flag(toChars(lineEnd), toChars(next - 1), true, "outline");
  }
}

// --- Slash commands -------------------------------------------------------------

/** One of the agent's slash commands, as its available_commands_update gives them. */
interface SlashCommand {
  name: string;
  description: string;
  /** What the command takes after its name, when it takes something. */
  hint?: string;
}

/** The / and the command name typed so far, when the request being typed is that and point is after it. */
function slashAtPoint(): { shell: Shell; start: number; end: number } | undefined {
  const shell = shellHere();
  const start = promptStart();
  if (shell === undefined || start === undefined || e8.point() < start) return undefined;
  const before = e8.bufferText(start, e8.point());
  const typed = /^\s*(\/\S*)$/.exec(before);
  if (!typed) return undefined;
  return { shell, start: e8.point() - charCount(typed[1]), end: e8.point() };
}

/** The agent's slash commands as completions of the / typed at point, as a completion-at-point function. */
function slashCompletions(): e8.Value {
  const at = slashAtPoint();
  if (at === undefined || at.shell.commands.length === 0) return null;
  return [at.start, at.end, at.shell.commands.map((c) => `/${c.name}`)];
}

/** Says what the slash command typed does, once it is whole: its description, and what it takes. */
function describeSlashCommand(shell: Shell, start: number): void {
  const typed = e8.bufferText(start, e8.point());
  const command = shell.commands.find((c) => `/${c.name}` === typed);
  if (command === undefined) return;
  const description = command.description.replace(/\s+/g, " ").trim();
  e8.message(`${typed}${description ? `: ${description}` : ""}${command.hint ? ` (takes ${command.hint})` : ""}`.replace(/%/g, "%%"));
}

/** TAB after a / at the start of the request: completes the agent's slash commands. */
function completeSlashCommand(): boolean {
  const at = slashAtPoint();
  if (at === undefined) return false;
  if (at.shell.commands.length === 0) {
    e8.message(`${at.shell.agent} has given no slash commands${at.shell.sessionId === undefined ? " yet" : ""}`);
    return true;
  }
  completionInRegion(at.start, at.end, at.shell.commands.map((c) => `/${c.name}`));
  describeSlashCommand(at.shell, at.start);
  return true;
}

/** Puts `text` at the prompt in place of the request being typed, point after it. */
function replaceRequest(start: number, text: string): void {
  e8.deleteRegion(start, e8.bufferSize());
  e8.gotoChar(start);
  e8.insert(text);
}

/** The requests sent, newest first, from every agent-shell buffer. */
function history(): string[] {
  const list = e8.variable("agent-shell-history");
  return Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : [];
}

/** Puts a request sent at the front of the history, once: an earlier copy goes, as history-delete-duplicates. */
function addToHistory(request: string): void {
  const size = Number(e8.variable("agent-shell-history-size") ?? 500);
  e8.setDefault("agent-shell-history", [request, ...history().filter((r) => r !== request)].slice(0, Math.max(0, size)));
}

/** Puts the request `arg` back in the history at the prompt, forward for a negative `arg`, as comint-previous-input. */
function historyMove(shell: Shell, arg: number): void {
  const ring = history();
  if (ring.length === 0) e8.userError("No history");
  const start = requestStart();
  if (shell.historyIndex === undefined) {
    if (arg < 0) e8.userError("End of history; no default available");
    shell.historyStored = e8.bufferText(start, e8.bufferSize());
  }
  const next = (shell.historyIndex ?? -1) + arg;
  if (next >= ring.length) e8.userError("Beginning of history; no preceding item");
  if (next < 0) {
    replaceRequest(start, shell.historyStored ?? "");
    shell.historyIndex = undefined;
    e8.message("Input restored");
    return;
  }
  shell.historyIndex = next;
  replaceRequest(start, ring[next]!);
  e8.message(`History item: ${next + 1}`);
}

e8.defineCommand({
  name: "agent-shell-previous-input",
  doc: "Put the request sent before back at the prompt; again, the one before that. With a prefix argument, that many back.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => historyMove(currentShell(), n),
});

e8.defineCommand({
  name: "agent-shell-next-input",
  doc: "Put the request sent after the one shown at the prompt, or what was being typed after the newest. With a prefix argument, that many forward.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => historyMove(currentShell(), -n),
});

e8.defineCommand({
  name: "agent-shell-search-history",
  doc: "Pick one of the requests sent before, with completion, and put it at the prompt.",
  run: async () => {
    const shell = currentShell();
    const ring = history();
    if (ring.length === 0) e8.userError("No history");
    const start = requestStart();
    // Each request on one line to pick from, the request itself put back whole.
    const shown = new Map<string, string>();
    for (const request of ring) {
      const line = request.replace(/\s*\n\s*/g, " ⏎ ");
      if (!shown.has(line)) shown.set(line, request);
    }
    const picked = await e8.completingRead("History: ", [...shown.keys()], { requireMatch: true });
    const request = shown.get(picked);
    if (request === undefined) return;
    replaceRequest(start, request);
    shell.historyIndex = undefined;
  },
});

e8.defineCommand({
  name: "agent-shell-send",
  doc: "Send the request under the last * You heading to the agent.",
  run: () => {
    const shell = currentShell();
    const start = requestStart();
    const request = e8.bufferText(start, e8.bufferSize()).trim();
    if (request === "") e8.userError("Type a request under the last * You heading first");
    if (shell.busy) e8.userError("The agent is still working; C-c C-k stops it");
    if (shell.loading) e8.userError("The session is still loading");
    // Kept for M-p, in every agent-shell buffer, and between sessions with savehist-mode.
    addToHistory(request);
    shell.historyIndex = undefined;
    shell.historyStored = undefined;
    // Sent, the request is the transcript's: read-only as the agent's turns, and
    // with no undo history, as nothing above it can change any more.
    writing(shell, () => lock(start, e8.bufferSize()));
    e8.setVariable("buffer-undo-list", null);
    shell.busy = true;
    shell.cancelled = false;
    showState(shell);
    startLine(shell);
    put(shell, "\n* Agent\n");
    e8.gotoChar(e8.bufferSize());
    prompt(shell, request);
  },
});

e8.defineCommand({
  name: "agent-shell-interrupt",
  doc: "Stop the agent's turn in this buffer: it is told to cancel, and its questions are answered as cancelled.",
  run: () => {
    const shell = currentShell();
    if (!shell.busy) e8.userError("The agent is not working on anything");
    cancelPermissions(shell);
    if (shell.sessionId !== undefined && acp.clientStartedP(shell.client)) {
      acp.sendNotification({ client: shell.client, notification: acp.makeSessionCancelNotification({ sessionId: shell.sessionId }) });
    } else {
      shell.cancelled = true;
    }
  },
});

// Killing a shell's buffer stops its agent.
e8.addHook("kill-buffer-hook", () => {
  const name = e8.bufferName() ?? "";
  const shell = shells.get(name);
  if (shell === undefined) return;
  shells.delete(name);
  cancelPermissions(shell);
  acp.shutdown({ client: shell.client });
});
