// The website's init.ts: E8's configuration, as yours would be in
// ~/.config/e8/init.ts. Change it, save it with C-x C-s, and reload the page,
// or run M-x load-file RET RET: what you save is yours, kept in this
// browser. The packages are repositories of their own in e8-editor,
// installed in repos/ beside this file and pinned in e8-lock.json, as
// e8.usePackage installs them on your computer.
//
// C-c followed by a letter is for your own keys, as in Emacs.

// ---------------------------------------------------------------------------
// Completion

// vertico lists candidates down the minibuffer: try M-x, C-x C-f or C-x b.
e8.usePackage("e8-editor/e8-vertico");
e8.setVariable("vertico-count", 12);
e8.setVariable("vertico-resize", true);
e8.setVariable("vertico-cycle", true);
e8.call("vertico-mode" as e8.CommandName);

// orderless matches the words you type in any order: M-x buf sw finds switch-to-buffer.
e8.usePackage("e8-editor/e8-orderless");
e8.setVariable("completion-styles", ["orderless", "basic"]);
e8.setVariable("completion-category-defaults", null);
e8.setVariable("completion-category-overrides", [["file", ["styles", "partial-completion"]]]);

// marginalia puts a note beside each candidate: a command's key and doc, a file's size.
e8.usePackage("e8-editor/e8-marginalia");
e8.call("marginalia-mode" as e8.CommandName);
e8.defineKey("minibuffer-local-map", "M-A", "marginalia-cycle" as e8.CommandName);

// consult's commands show the candidate as you move to it: M-s l searches
// the buffer's lines, M-g o its headings, C-x b buffers and recent files.
e8.usePackage("e8-editor/e8-consult");
for (const [keys, command] of [
  ["C-x b", "consult-buffer"],
  ["C-x 4 b", "consult-buffer-other-window"],
  ["C-c m", "consult-mode-command"],
  ["M-y", "consult-yank-pop"],
  ["M-g g", "consult-goto-line"],
  ["M-g M-g", "consult-goto-line"],
  ["M-g o", "consult-outline"],
  ["M-g i", "consult-imenu"],
  ["M-g m", "consult-mark"],
  ["M-s l", "consult-line"],
  ["C-c r", "consult-recent-file"],
] as const) {
  e8.bindKey(keys, command as e8.CommandName);
}
e8.defineKey("minibuffer-local-map", "M-r", "consult-history" as e8.CommandName);
e8.setVariable("consult-narrow-key", "<");

// ---------------------------------------------------------------------------
// More packages

// vundo shows the undo history as a tree: C-z, then the arrow keys.
e8.usePackage("e8-editor/e8-vundo");
e8.bindKey("C-z", "vundo" as e8.CommandName);

// Casual's menu for Dired: C-x d RET, then ?.
e8.usePackage("e8-editor/e8-casual");
e8.defineKey("dired-mode-map", "?", "casual-dired-tmenu" as e8.CommandName);

// *scratch* is kept from one visit to the next.
e8.usePackage("e8-editor/e8-persistent-scratch");
e8.funcall("persistent-scratch-setup-default");

// ---------------------------------------------------------------------------
// Built in

// Recent files, the minibuffer's history and where you were in each file,
// kept from one visit to the next.
e8.call("recentf-mode");
e8.call("savehist-mode");
e8.call("save-place-mode");

// Parens and quotes in pairs, line numbers in code, long lines wrapped at words.
e8.call("electric-pair-mode");
e8.addHook("prog-mode-hook", () => e8.call("display-line-numbers-mode"));
e8.call("global-visual-line-mode");

e8.setDefault("indent-tabs-mode", false);
e8.setVariable("sentence-end-double-space", false);
e8.setVariable("use-short-answers", true);

// Windows split side by side when the frame is wide enough.
e8.setDefault("split-height-threshold", null);
e8.setDefault("split-width-threshold", 160);

// Org: headings indented, done items dated, and <s TAB for a source block.
e8.setVariable("org-startup-indented", true);
e8.setVariable("org-ellipsis", " [+] ");
e8.setVariable("org-log-done", "time");
e8.setVariable("org-fontify-done-headline", true);
e8.setVariable("org-return-follows-link", true);
e8.require("org-tempo");

// A command of your own: C-c d inserts today's date.
const insertDate = e8.defineCommand({
  name: "insert-date",
  doc: "Insert today's date, such as 2026-11-08.",
  run: () => {
    e8.insert(new Date().toISOString().slice(0, 10));
  },
});
e8.bindKey("C-c d", insertDate);
