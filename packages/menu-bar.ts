// The menu bar, after Emacs's menu-bar.el: File, Edit, Options, Buffers,
// Tools and Help, bound under [menu-bar] in the global keymap, where the
// editor's menu bar finds them. menu-bar-mode shows the bar; F10 opens it,
// and a click on it opens the menu under the pointer. Unlike Emacs, E8
// shows no menu bar until menu-bar-mode is on (docs/differences.md).

import { easyMenuDefine, easyMenuFill, separator, type MenuItem } from "easymenu";
import { truthy } from "subr";

// --- The menus ---------------------------------------------------------------

easyMenuDefine("file", ["global-map"], "Files and windows.", {
  label: "File",
  items: [
    { label: "Visit New File...", command: "find-file", help: "Read a file into a buffer, or make a new one" },
    { label: "Open File in Other Window...", command: "find-file-other-window" },
    { label: "Open Directory...", command: "dired", help: "List a directory, to act on its files" },
    { label: "Insert File...", command: "insert-file", help: "Insert a file's text at point" },
    separator,
    { label: "Save", command: "save-buffer", enable: () => truthy(e8.bufferModified()) },
    { label: "Save As...", command: "write-file" },
    { label: "Save All", command: "save-some-buffers" },
    { label: "Revert Buffer", command: "revert-buffer" },
    { label: "Recover This File", command: "recover-this-file" },
    separator,
    { label: "Split Window", command: "split-window-below" },
    { label: "Split Window Right", command: "split-window-right" },
    { label: "Unsplit Windows", command: "delete-other-windows" },
    { label: "Close Window", command: "delete-window" },
    separator,
    { label: "Quit", command: "save-buffers-kill-terminal", help: "Save what is unsaved and leave E8" },
  ],
});

easyMenuDefine("edit", ["global-map"], "Editing the text.", {
  label: "Edit",
  items: [
    { label: "Undo", command: "undo" },
    { label: "Redo", command: "undo-redo" },
    separator,
    { label: "Cut", command: "kill-region", enable: () => e8.regionActive() },
    { label: "Copy", command: "kill-ring-save", enable: () => e8.regionActive() },
    { label: "Paste", command: "yank" },
    separator,
    { label: "Select All", command: "mark-whole-buffer" },
    separator,
    { label: "Search...", command: "isearch-forward" },
    { label: "Replace...", command: "query-replace" },
    { label: "Go to Line...", command: "goto-line" },
    separator,
    { label: "Spell-Check Buffer", command: "ispell-buffer" },
  ],
});

easyMenuDefine("options", ["global-map"], "What the editor does.", {
  label: "Options",
  items: [
    { label: "Line Numbers", command: "display-line-numbers-mode", style: "toggle", selected: () => truthy(e8.variable("display-line-numbers-mode")) },
    { label: "Word Wrap", command: "visual-line-mode", style: "toggle", selected: () => truthy(e8.variable("visual-line-mode")) },
    { label: "Truncate Long Lines", command: "toggle-truncate-lines", style: "toggle", selected: () => truthy(e8.variable("truncate-lines")) },
    separator,
    { label: "Menu Bar", command: "menu-bar-mode", style: "toggle", selected: () => truthy(e8.variable("menu-bar-mode")) },
    { label: "Tab Bar", command: "tab-bar-mode", style: "toggle", selected: () => truthy(e8.variable("tab-bar-mode")) },
  ],
});

// --- The Buffers menu, made again each time the bar is laid out ---------------

e8.defineVariable({
  name: "buffers-menu-max-size",
  value: 10,
  doc: "How many buffers the Buffers menu lists before it offers the buffer list instead.",
});

/** The buffers a user would choose from, as Emacs's Buffers menu lists. */
function listedBuffers(): string[] {
  return e8.bufferList().filter((name) => !name.startsWith(" "));
}

/** How many buffers the menu can list: its commands are made once. */
const MOST_BUFFERS = 20;

/** The buffers the menu is showing now, which its commands go to. */
let shown: string[] = [];

for (let i = 0; i < MOST_BUFFERS; i += 1) {
  e8.defineCommand({
    name: `menu-bar-select-buffer-${i}`,
    doc: "Show the buffer this item of the Buffers menu names.",
    run: () => {
      const name = shown[i];
      if (name !== undefined) {
        e8.call("switch-to-buffer", name);
      }
    },
  });
}

/** The keymap the Buffers menu lives in, made once and filled again. */
const buffersMenu = e8.makeSparseKeymap();

e8.defineMenuItem("global-map", "<menu-bar> <buffer>", { label: "Buffers", binding: buffersMenu, help: "Go to one of the buffers" });

/** What the menu is showing now, so it is made again only when it changes. */
let listed = "";

/**
 * Makes the Buffers menu again, as menu-bar-update-buffers does: only
 * when the buffers it lists have changed, as Emacs's
 * frame-or-buffer-changed-p asks, and never while a menu is open, whose
 * items would move under the pointer.
 */
function updateBuffersMenu(): void {
  if (e8.menuOrPopupActiveP()) {
    return;
  }
  const max = e8.variable("buffers-menu-max-size");
  const buffers = listedBuffers();
  const limit = Math.min(typeof max === "number" ? max : buffers.length, MOST_BUFFERS);
  const now = buffers.slice(0, limit);
  const key = `${now.join("\u0000")}/${buffers.length}`;
  if (key === listed) {
    return;
  }
  listed = key;
  shown = now;
  const items: MenuItem[] = now.map((name, i) => ({
    label: name,
    key: `buffer-${i}`,
    command: `menu-bar-select-buffer-${i}` as e8.CommandName,
  }));
  if (buffers.length > now.length) {
    items.push(separator, { label: "List All Buffers", command: "list-buffers" });
  }
  items.push(separator, { label: "Select Buffer...", command: "switch-to-buffer" });
  // The same keymap filled again, since keymaps are never freed.
  for (const old of e8.keymapMenuKeys(buffersMenu)) {
    e8.keymapUnset(buffersMenu, old, true);
  }
  easyMenuFill(buffersMenu, items);
}

e8.addHook("menu-bar-update-hook", updateBuffersMenu);
updateBuffersMenu();

easyMenuDefine("tools", ["global-map"], "Programs and other windows on the world.", {
  label: "Tools",
  items: [
    { label: "Compile...", command: "compile" },
    { label: "Search Files (Grep)...", command: "grep" },
    { label: "Find File in Project...", command: "project-find-file" },
    separator,
    { label: "Shell Command...", command: "shell-command" },
    { label: "Shell", command: "shell" },
    separator,
    { label: "Org Agenda", command: "org-agenda" },
    { label: "Evaluate Expression...", command: "eval-expression" },
  ],
});

easyMenuDefine("help-menu", ["global-map"], "Describing E8.", {
  label: "Help",
  items: [
    { label: "Describe Key...", command: "describe-key" },
    { label: "Describe Function...", command: "describe-function" },
    { label: "Describe Variable...", command: "describe-variable" },
    { label: "Describe Mode", command: "describe-mode" },
    { label: "Describe Face...", command: "describe-face" },
    separator,
    { label: "List Key Bindings", command: "describe-bindings" },
    { label: "Search Commands...", command: "apropos-command" },
    { label: "List Faces", command: "list-faces-display" },
    separator,
    { label: "Show Messages", command: "view-echo-area-messages" },
  ],
});

// The menus go in Emacs's order, Help last.
e8.setVariable("menu-bar-final-items", ["help-menu"]);

// --- The mode ----------------------------------------------------------------

e8.defineMinorMode({
  name: "menu-bar-mode",
  doc: "Show a menu bar along the top of each frame. F10 opens it, and a click on it opens the menu under the pointer.",
  global: true,
  onChange: (enabled) => {
    for (const frame of e8.frameList()) {
      e8.setFrameParameter(frame, "menu-bar-lines", enabled ? 1 : 0);
    }
  },
});
