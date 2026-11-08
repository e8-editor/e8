# 0061. Agents over ACP

Status: accepted · 2026-11-06

## Context

E8 has one agent, `M-x agent` ([ADR 0019](0019-agent-buffer.md)): a Rust crate that calls the Claude Messages API with a key from the keychain, runs E8's commands as tools in the user's window, and asks before anything it cannot undo. It is one model from one vendor, and it needs an API key, which most people who use Claude in an editor do not have: they use Claude Code, on a subscription.

The coding agents people use today (Claude Code, Gemini CLI, Codex, Goose, Cursor's) are programs of their own, with their own tools, context and login. Editors talk to them over the **Agent Client Protocol** (ACP), which Zed started and which now has its own organisation: JSON-RPC 2.0 over the agent's standard input and output, one JSON object per line, the editor the client and the agent a subprocess. The client opens a session in a directory, sends prompts, and receives the reply as a stream of updates: text, thinking, tool calls with their status and diffs, plans. The agent calls back into the editor to read and write files (so it sees unsaved text and its writes land in buffers), to run terminals, and to ask the user's permission before a tool runs. Zed, JetBrains and Neovim speak it, and in Emacs `agent-shell` does, on a client library, `acp.el`, both by Alvaro Ramirez and both GPL-3.

Claude reaches ACP through an adapter, `@agentclientprotocol/claude-agent-acp` (formerly Zed's `@zed-industries/claude-code-acp`), a Node program on the Claude Agent SDK, which runs the Claude Code CLI and so uses its login, or `ANTHROPIC_API_KEY` if the environment has one. agent-shell launches that adapter and leaves authentication to it.

Agreed on 2026-11-05 and recorded since only as a note: ACP rather than driving `claude -p`; the client a port of the Emacs packages; E8 never handling an agent's credentials; `e8-agent` becoming one backend among several. This ADR records it, now that packages, batch mode and CI, which it waited for, are in place.

### What the subscription terms say, as of 2026-11-06

Recorded so that nothing is built on them. Anthropic's help article "Use the Claude Agent SDK with your Claude plan" has two notes: on 2026-06-15, that an announced change to credits is paused and that "Claude Agent SDK, `claude -p`, and third-party app usage" still draw from subscription limits; on 2026-10-07, that Max, Ultra and Team plans get monthly API credits, which cover the SDK and `claude -p` when run with an API key from a linked Console organisation. It names no approved clients and does not mention ACP. Enforcement has been per integration rather than per protocol: a JetBrains user's ACP route was refused with "This integration does not support using claude.ai subscriptions" (JetBrains LLM-26415) while Zed's worked. The terms changed twice in 2026; E8's design must not depend on them.

## Options considered

1. **Keep only the Messages API agent.** It works, and E8 controls every step, but it needs an API key, it is one vendor's model, and it reimplements what Claude Code already does well: reading a project, editing files, running commands.
2. **Drive `claude -p --output-format stream-json`.** A Claude Code process per turn, its JSON events parsed into a buffer. It is tied to one program's flags, permissions go through a `--permission-prompt-tool` workaround, and the files it writes change under open buffers.
3. **ACP, with the client in Rust.** Zed's `agent-client-protocol` crate exists. But what Emacs writes in Lisp E8 writes in TypeScript ([ADR 0005](0005-rust-core-typescript-commands.md)), the traffic is a JSON line per token at reading speed, which costs V8 nothing, and the protocol is young: its Claude adapter has changed name twice this year. In Rust every protocol change would wait for an editor release, and the client would still need natives to reach the buffer, which is TypeScript.
4. **ACP, with the client in TypeScript, as a package.** A port of `acp.el`, which a package can follow as the protocol moves, on `e8.makeProcess`. Chosen.

For the buffer the client drives, there were three ways: a port of agent-shell itself, 34,000 lines over fifty files on `shell-maker`, another 2,400, before anything ran; one `M-x agent` with backends now, which reworks the Rust agent and its sixteen scenarios in the same change; or a new command on the agent buffer E8 already has. The third is chosen, the second follows it.

## Decision

E8 talks to coding agents over ACP, launching whatever adapter the configuration names. The client and its buffer ship with E8, as `eglot.ts` carries LSP.

- **`packages/acp.ts`** is a port of `acp.el`, under its names: a client made from a command line and environment, requests with their answers matched by id (each a promise, or waited for), notifications, responses to the agent's own requests, subscriptions to requests, notifications and errors, the builders for each message, and shutdown, which closes the agent's input and stops its process group. Incoming messages queue and drain on a timer within a time budget, as acp.el's do, so a chatty agent never holds up typing, and a handler that fails never stops the queue. The agent's standard error goes to a buffer of its own, which needs `make-process`'s `:stderr` buffer in the core (the one change there). `*acp-logs*` and `*acp-traffic*` show what passed, when `acp-logging-enabled` is on.
- **`packages/agent-shell.ts`** is `M-x agent-shell`, named after Emacs's package and following its design, not its code: the agents a configuration knows in `agent-shell-agents` (each a name and a command line: `claude-agent-acp`, `gemini --experimental-acp`, `codex-acp` and the rest, as agent-shell's are), a session per buffer in the project's root, and the conversation in ADR 0019's Org buffer: `* You` and `* Agent` headings, `C-c RET` to send, `C-c C-k` to cancel, the reply streaming in, each tool call a line whose content, diff or output is in a block below it, folded once it is done, and the agent's plan as a checklist. It serves the agent's callbacks:
  - **Permission.** `session/request_permission` asks the user ("Let claude edit src/main.rs? (y, n or ! for always)"), the answer going back as the option the agent offered. It is asked from the drain timer, as [ADR 0053](0053-prompts-that-return-their-answer.md) allows, and waits while the user has any question of their own open, as ADR 0019's agent does. The agent cannot answer for the user; its request is the gate.
  - **Files.** `fs/read_text_file` reads the buffer visiting the file, unsaved text included, or the file. `fs/write_text_file` writes into the visiting buffer, or one it visits, through `insdel.rs` like any edit, so it is undoable and runs the change hooks, and then saves it.
- **The agent writes Markdown; the buffer makes it Org** (amended 2026-11-06, after the first use by hand). Agents answer in Markdown, and a prompt asking for Org can't be relied on: only Claude's adapter is known to read a system prompt from the client, models drift back to Markdown in long turns, and tool output comes as it comes. So `agent-shell.ts` converts each line of the reply once its newline arrives, as gptel does in Org buffers: a fenced block becomes a src block (its lines that Org would take for a heading or the block's end escaped with a comma), a heading a bold line, since the conversation's own headings are Org's, `*` and `+` bullets `-`, and emphasis, code, links and table rules Org's. The line still coming shows as it came until it is whole, so a `**` cut between two chunks is never misread. A tool call's title is Org code, `~git diff | grep -E '^+'~`, so a shell command's slashes and pluses are not read as emphasis, and its block folds into its line, which TAB opens (`org-cycle-tab-first-hook`). The mode line shows `:working` and how much of the context is used (`mode-line-process`, which the core gains, as Emacs's), and the header line the keys. Org stays the container: headings to fold and move between, blocks, checklists, links, export, and refiling an answer into one's notes.
- **The buffer is a transcript, not the conversation** (amended 2026-11-07, after the first editing by hand). Under ACP the conversation lives in the agent: `session/prompt` appends, and nothing takes a turn back. So the buffer above the request being typed is read-only, as comint's and agent-shell's are, the agent's turns and the requests sent alike, and the agent writes them without recording undo, so undo reaches only the request being typed and the buffer never shows what the agent no longer has. gptel's other model, where the buffer is the conversation and editing it changes what the model sees next, needs the client to hold the messages; it is for the Messages API backend when one `M-x agent` has backends (item 3 below). What a transcript allows instead (2026-11-08): the requests sent come back to the prompt with `M-p`, `M-n` and `M-r`, as comint's and shell-maker's do, and since nothing can be typed into the transcript, Org's speed commands run anywhere in it, through the function form of `org-use-speed-commands`, with the editing ones left out of the buffer's table.
- **Authentication is the adapter's.** E8 passes no key and stores none. When an agent says it needs a login, the buffer says to log in with that agent outside E8 once, as agent-shell's README does.
- **The core gains nothing agent-specific.** `Editor::check_permission` is not involved: an ACP agent's tools run in its own process, not through E8's commands. It will be once the session is given `e8-mcp` as an MCP server.

Later, in this order, each when it is wanted:

1. Terminals: `terminal/create` and the rest, on `makeProcess`, shown in the tool call's block.
2. `e8-mcp` given to each session as an MCP server, so an ACP agent can use the editor's commands too, under `check_permission` as ADR 0019's agent does. Done: [ADR 0062](0062-agents-through-e8-mcp-ask-first.md).
3. One `M-x agent`, its buffer's code in TypeScript, with `e8-agent` one backend and ACP agents the others.
4. An agent's edits arriving as changes to review and accept by hunk, rather than written at once.
5. The frame as what the agent sees, from `describe_frame`.
6. Porting an Emacs Lisp package with an agent: a draft package in the user's packages directory, with its tests, for the user to read before using ([ADR 0059](0059-packages-are-git-repositories.md)).

## Consequences

- Anyone with Claude Code, Gemini CLI or another ACP agent can use it from E8, on whatever login that agent has; no key reaches E8.
- The agent's file access goes through buffers, so it sees what the user has not saved, and its writes are undoable edits rather than files changing under open buffers.
- Using Claude this way needs Node 22 or newer and the adapter (`npm install -g @agentclientprotocol/claude-agent-acp`), which E8 neither ships nor installs.
- There are two agent buffers until the third item above, `M-x agent` and `M-x agent-shell`.
- `acp.ts` follows GPL-3 code closely; `docs/licensing.md` records it, as for the Org files. `agent-shell.ts` follows only the design.
- Found on 2026-11-06, running Claude Code's adapter: it reads and writes files with its own tools, asking under Claude Code's permission settings, and calls neither `fs/` method nor `session/request_permission` while those settings allow the edit. So with Claude the buffer-backed file methods go unused, and `agent-shell.ts` reverts the unmodified buffers of files a finished tool call touched instead. Agents that do call them get buffers; `e8-mcp` as the session's MCP server (later, item 2) is the way to put Claude's edits through buffers.
- Watch for: QuickJS keeping up with a fast stream (if not, a native for splitting lines, not the whole client); and the protocol's version 2, which the Claude adapter already serves to clients that ask for it.

## Dependencies introduced

None in E8. The adapters are the user's programs.
