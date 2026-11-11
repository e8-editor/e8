// An example init.ts. Copy it to ~/.config/e8/init.ts (or $E8_CONFIG_DIR).
//
// E8 loads this file at startup. After editing it, run M-x load-file to
// reload it into the running editor. E8 writes e8.d.ts and tsconfig.json
// next to it, so `tsc -p ~/.config/e8` checks it against the real commands.
//
// C-c followed by a letter is reserved for your own bindings, as in Emacs.

// List completions down the minibuffer, with keys like ido's: RET takes the
// first or goes into a directory, DEL goes up one, C-n and C-p move.
e8.call("fido-vertical-mode");

// Remember recently visited files across sessions; M-x recentf-open visits one.
e8.call("recentf-mode");

// Keep minibuffer history between sessions, and go back to where you were
// in each file when you visit it again.
e8.call("savehist-mode");
e8.call("save-place-mode");

// Type parens and quotes in pairs.
e8.call("electric-pair-mode");

// Number lines in buffers of code.
e8.addHook("prog-mode-hook", () => e8.call("display-line-numbers-mode"));

// Break lines as you type in prose.
e8.addHook("text-mode-hook", () => e8.call("auto-fill-mode"));

const insertDate = e8.defineCommand({
  name: "insert-date",
  doc: "Insert today's date, such as 2026-10-27.",
  run: () => {
    e8.insert(new Date().toISOString().slice(0, 10));
  },
});
e8.bindKey("C-c d", insertDate);

const surroundRegion = e8.defineCommand({
  name: "surround-region",
  doc: "Put text before and after the region.\n\nWith no region, inserts both at point.",
  params: [
    { name: "before", prompt: "Before: " },
    { name: "after", prompt: "After (empty for the same): " },
  ],
  run: (before, after) => {
    const point = e8.point();
    const mark = e8.mark() ?? point;
    const [start, end] = [Math.min(point, mark), Math.max(point, mark)];
    e8.gotoChar(end);
    e8.insert(after === "" ? before : after);
    e8.gotoChar(start);
    e8.insert(before);
  },
});
e8.bindKey("C-c s", surroundRegion);

// Built-in commands are checked too: a misspelt name or a missing argument is
// a type error.
e8.bindKey("C-c f", "find-file");

const countWords = e8.defineCommand({
  name: "count-words",
  doc: "Show how many words the buffer has.",
  run: () => {
    const words = e8.bufferText().split(/\s+/).filter((w) => w !== "");
    e8.message(`${e8.bufferName()} has ${words.length} words`);
  },
});
e8.bindKey("C-c w", countWords);

// A command that asks as it goes, awaiting each answer, and takes the
// prefix argument as a count: C-u 3 C-c n asks for three notes.
const jotNotes = e8.defineCommand({
  name: "jot-notes",
  doc: "Ask for notes, as many as the prefix argument says, and add each to *notes* with the time.",
  params: [{ name: "count", kind: "count" }],
  run: async (count: number) => {
    e8.getBufferCreate("*notes*");
    for (let i = 1; i <= count; i++) {
      const note = await e8.readString(count > 1 ? `Note ${i} of ${count}: ` : "Note: ");
      e8.withCurrentBuffer("*notes*", () => e8.insert(`${new Date().toISOString().slice(11, 16)} ${note}\n`));
    }
    if (await e8.yOrNP("Show the notes? ")) e8.call("switch-to-buffer", "*notes*");
  },
});
e8.bindKey("C-c n", jotNotes);

// Spell checking in English and Swedish at once: Hunspell takes several
// dictionaries, and words either knows are right. M-x
// ispell-change-dictionary picks another for a buffer, and a file can name
// its own with a line "Local IspellDict: sv_SE".
// e8.setVariable("ispell-program-name", "hunspell");
// e8.setVariable("ispell-dictionary", "en_US,sv_SE");

// Org's agenda and capture, on the keys Org's manual suggests. Emacs leaves
// them unbound, as E8 does.
e8.setVariable("org-agenda-files", ["~/org/notes.org"]);
e8.setVariable("org-capture-templates", [
  ["t", "Task", "entry", ["file+headline", "~/org/notes.org", "Inbox"], "* TODO %?\n  %u\n"],
]);
e8.bindKey("C-c a", "org-agenda");
e8.bindKey("C-c c", "org-capture");
