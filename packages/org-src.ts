// Editing a source block in its own mode, after Org's org-src.el: C-c ' in
// a #+begin_src or #+begin_example block shows its text in *Org Src ...*,
// in the language's major mode; C-c ' there puts it back and C-c C-k leaves
// the block as it was.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { eraseBuffer, PerBuffer } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("org-src-lang-modes", [
  ["C", "c"], ["C++", "c++"], ["cpp", "c++"], ["elisp", "emacs-lisp"], ["shell", "sh"], ["bash", "sh"], ["sh", "sh"],
  ["calc", "fundamental"], ["dot", "fundamental"], ["sqlite", "sql"], ["toml", "conf-toml"],
], "The major modes of source blocks' languages, as [language, mode] lists, the mode without -mode; others are LANGUAGE-mode.");
defvar("org-src-window-setup", "reorganize-frame", "Where C-c ' shows a block's text: reorganize-frame, current-window, other-window, split-window-below or split-window-right.");
defvar("org-src-tab-acts-natively", true, "Whether TAB in a source block indents its line as the language's mode would.");
defvar("org-src-fontify-natively", true, "Whether a source block's text has the faces its language's mode gives it.");
defvar("org-edit-src-persistent-message", true, "Whether the block's buffer says in its header line how to finish.");

/** What a block's buffer edits: where in which buffer, and how its text goes back. */
interface Edit {
  beg: e8.Marker;
  end: e8.Marker;
  source: string;
  blockIndentation: number;
  contentIndentation: number;
  preserve: boolean;
  windows?: e8.WindowConfiguration;
}

const edits = new PerBuffer<Edit>();

const BEGIN = /^([ \t]*)#\+begin_(src|example)(?:[ \t]+(\S+))?(.*)$/i;
const END = /^[ \t]*#\+end_(src|example)[ \t]*$/i;

/** The block point is in: its begin and end lines, its kind and language, as org-element-at-point finds them. */
function blockAt(): { begin: number; end: number; kind: string; lang?: string; indent: number; switches: string } | undefined {
  const line = e8.lineOf(e8.point());
  for (let l = line; l >= 0; l--) {
    const text = e8.lineText(l);
    if (l < line && END.test(text)) return undefined;
    const m = BEGIN.exec(text);
    if (!m) continue;
    for (let e = l + 1; e < e8.lineCount(); e++) {
      const close = END.exec(e8.lineText(e));
      if (!close) continue;
      if (close[1].toLowerCase() !== m[2].toLowerCase() || e < line) return undefined;
      return { begin: l, end: e, kind: m[2].toLowerCase(), lang: m[3], indent: m[1].replace(/\t/g, "        ").length, switches: m[4] ?? "" };
    }
    return undefined;
  }
  return undefined;
}

/** The major mode for a language, as org-src-get-lang-mode: its entry in org-src-lang-modes, or itself, with -mode. */
function langMode(lang: string): string {
  const alist = e8.variable("org-src-lang-modes");
  const entry = Array.isArray(alist) ? (alist.find((e) => Array.isArray(e) && e[0] === lang) as e8.Value[] | undefined) : undefined;
  return `${entry ? String(entry[1]) : lang}-mode`;
}

/** The indentation all non-blank lines share. */
function commonIndentation(text: string): number {
  const indents = text.split("\n").filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].replace(/\t/g, "        ").length);
  return indents.length === 0 ? 0 : Math.min(...indents);
}

/** Takes `n` columns of indentation off each line, as org-do-remove-indentation. */
function removeIndentation(text: string, n: number): string {
  if (n === 0) return text;
  return text.split("\n").map((l) => {
    let col = 0;
    let i = 0;
    while (i < l.length && col < n && (l[i] === " " || l[i] === "\t")) {
      col = l[i] === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
      i++;
    }
    return l.slice(i);
  }).join("\n");
}

/** Shows a block's buffer, or the Org buffer again, as org-src-switch-to-buffer does for org-src-window-setup. */
function switchTo(buffer: string, context: "edit" | "exit"): void {
  const setup = String(e8.variable("org-src-window-setup") ?? "reorganize-frame");
  if (setup === "current-window") e8.call("switch-to-buffer", buffer);
  else if (setup === "other-window") e8.call("switch-to-buffer-other-window", buffer);
  else if (setup === "split-window-below" || setup === "split-window-right") {
    if (context === "edit") e8.selectWindow(e8.splitWindow(undefined, setup === "split-window-below" ? "below" : "right"));
    e8.call("switch-to-buffer", buffer);
  } else if (context === "edit") {
    if (e8.windowList().length === 1) e8.splitWindow(undefined, "below");
    e8.call("switch-to-buffer-other-window", buffer);
  } else e8.call("switch-to-buffer", buffer);
}

type Block = NonNullable<ReturnType<typeof blockAt>>;

/**
 * Makes the buffer that edits a block, as org-src--edit-element does: its
 * text without the indentation its lines share, in the language's mode,
 * point where it was in the block. The current buffer stays as it was.
 */
function openEdit(block: Block): { name: string; edit: Edit } {
  const lang = block.kind === "src" ? block.lang ?? "" : "example";
  const mode = block.kind === "src" ? langMode(lang) : undefined;
  if (mode !== undefined && !e8.commandNames().includes(mode)) e8.signal("error", `No such language mode: ${mode}`);
  const begPos = e8.lineStart(block.begin + 1);
  const endPos = e8.lineStart(block.end);
  const source = e8.bufferName();
  // Where point is, by line and column within the block, as org-src--coordinates.
  const point = e8.point();
  const from = Math.max(point, begPos);
  const coords: [number, number] | "end" = point >= endPos ? "end" : [e8.lineOf(from) - (block.begin + 1), from - e8.lineStart(e8.lineOf(from))];
  const preserve = e8.variable("org-src-preserve-indentation") === true || /(^|\s)-i(\s|$)/.test(block.switches);
  let text = e8.bufferSubstringNoProperties(begPos, endPos);
  const removed = preserve ? 0 : commonIndentation(text);
  text = removeIndentation(text, removed);
  const edit: Edit = {
    beg: e8.makeMarker(begPos),
    end: e8.makeMarker(endPos, { advances: true }),
    source,
    blockIndentation: block.indent,
    contentIndentation: Number(e8.variable("org-edit-src-content-indentation") ?? 2),
    preserve,
  };
  const name = `*Org Src ${source}[ ${lang} ]*`;
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    eraseBuffer();
    e8.insert(text);
    if (mode !== undefined) e8.call(mode as e8.CommandName);
    edits.set(e8.currentBuffer(), edit);
    e8.callWithPrefix(1, orgSrcMode);
    e8.setBufferModified(false);
    if (coords === "end") e8.gotoChar(Math.max(e8.bufferSize() - 1, 0));
    else {
      const line = Math.min(coords[0], e8.lineCount() - 1);
      e8.gotoChar(Math.min(e8.lineStart(line) + Math.max(coords[1] - removed, 0), e8.lineEnd(line)));
    }
  });
  return { name, edit };
}

/** Edits the block at point in its language's mode, as org-edit-src-code. */
function editSrcCode(): void {
  const block = blockAt();
  if (!block) e8.userError("Not in a source or example block");
  const source = e8.bufferName();
  const begPos = e8.lineStart(block.begin + 1);
  // An edit of this block already under way is gone back to, as org-src--edit-buffer finds it.
  const existing = e8.bufferList().find((b) => {
    const e = e8.getBuffer(b) && edits.get(b);
    return e !== undefined && e8.markerBuffer(e.beg) === source && e8.markerPosition(e.beg) === begPos;
  });
  if (existing !== undefined) {
    switchTo(existing, "edit");
    return;
  }
  const windows = e8.currentWindowConfiguration();
  const { name, edit } = openEdit(block);
  edit.windows = windows;
  switchTo(name, "edit");
}

/** The block's buffer's text as it goes back: each non-blank line indented by the block's and its content's indentation. */
function contentsForWriteBack(edit: Edit): string {
  const text = e8.bufferSubstringNoProperties(0, e8.bufferSize());
  const offset = edit.preserve ? 0 : edit.blockIndentation + edit.contentIndentation;
  const body = offset > 0 ? text.split("\n").map((l) => (l === "" ? l : " ".repeat(offset) + l)).join("\n") : text;
  return body === "" || body.endsWith("\n") ? body : `${body}\n`;
}

/** Puts the block's buffer's text back in place of the block's, if it changed. */
function writeBack(edit: Edit, text: string): void {
  e8.withCurrentBuffer(edit.source, () => {
    const beg = e8.markerPosition(edit.beg) ?? 0;
    const end = e8.markerPosition(edit.end) ?? beg;
    if (e8.bufferSubstringNoProperties(beg, end) === text) return;
    // Wherever the Org buffer is narrowed to now, as org-edit-src-exit
    // narrows to the block itself to put the text back.
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        e8.gotoChar(beg);
        e8.deleteRegion(beg, end);
        e8.insert(text);
      }),
    );
  });
}

/** Leaves the block's buffer for the Org buffer, writing its text back unless `abort`, as org-edit-src-exit. */
function exit(abort: boolean): void {
  const edit = edits.get(e8.currentBuffer());
  if (!edit) e8.signal("error", "Not in a sub-editing buffer");
  const lineInEdit = e8.lineOf(e8.point());
  const colInEdit = e8.point() - e8.lineStart(lineInEdit);
  const text = contentsForWriteBack(edit);
  const name = e8.bufferName();
  if (!e8.bufferList().includes(edit.source)) e8.signal("error", "Source buffer disappeared.  Aborting");
  if (!abort) writeBack(edit, text);
  e8.setBufferModified(false);
  edits.delete(e8.currentBuffer());
  if (edit.windows) e8.setWindowConfiguration(edit.windows);
  switchTo(edit.source, "exit");
  e8.call("kill-buffer", name);
  returnPoint(edit, abort ? undefined : [lineInEdit, colInEdit]);
}

/** Puts point back in the Org buffer where it was in the block's buffer, as org-src--goto-coordinates, and frees the edit's markers. */
function returnPoint(edit: Edit, at: [number, number] | undefined): void {
  const beg = e8.markerPosition(edit.beg) ?? 0;
  if (at === undefined) e8.gotoChar(beg);
  else {
    const line = e8.lineOf(beg) + at[0];
    const offset = edit.preserve ? 0 : edit.blockIndentation + edit.contentIndentation;
    e8.gotoChar(Math.min(e8.lineStart(line) + at[1] + offset, e8.lineEnd(line)));
  }
  e8.deleteMarker(edit.beg);
  e8.deleteMarker(edit.end);
}

/**
 * Runs `body` in the block at point's edit buffer, in its language's mode,
 * unseen, and puts the text back, point following it, as
 * org-babel-do-in-edit-buffer does with org-src-window-setup
 * switch-invisibly. Nothing happens outside a source block, or for a
 * language whose mode E8 lacks.
 */
function doInEditBuffer(body: () => void): void {
  const block = blockAt();
  if (!block || block.kind !== "src") return;
  const outside = e8.lineBeginningPosition() <= e8.lineStart(block.begin) ? e8.makeMarker(e8.point()) : undefined;
  let opened: { name: string; edit: Edit };
  try {
    opened = openEdit(block);
  } catch {
    if (outside) e8.deleteMarker(outside);
    return;
  }
  const { name, edit } = opened;
  let at: [number, number] = [0, 0];
  let text = "";
  e8.withCurrentBuffer(name, () => {
    try {
      body();
    } finally {
      const line = e8.lineOf(e8.point());
      at = [line, e8.point() - e8.lineStart(line)];
      text = contentsForWriteBack(edit);
      edits.delete(e8.currentBuffer());
      e8.setBufferModified(false);
    }
  });
  writeBack(edit, text);
  e8.call("kill-buffer", name);
  returnPoint(edit, at);
  if (outside) {
    e8.gotoChar(e8.markerPosition(outside) ?? e8.point());
    e8.deleteMarker(outside);
  }
}

/**
 * Runs `command` on the block at point in its language's mode, unseen, and
 * puts the text back, as org-babel-do-key-sequence-in-edit-buffer does:
 * how TAB indents a source block's line with org-src-tab-acts-natively.
 */
e8.defun("org-babel-do-key-sequence-in-edit-buffer", (command: e8.Value) => doInEditBuffer(() => e8.call(String(command) as e8.CommandName)));

/** Calls `fn` in the block at point's edit buffer, as org-babel-do-in-edit-buffer: how org-indent-region indents a source block's code. */
e8.defun("org-babel-do-in-edit-buffer", (fn: string | ((...args: unknown[]) => unknown)) => doInEditBuffer(() => e8.funcall(fn)));

const exitCommand = e8.defineCommand({
  name: "org-edit-src-exit",
  doc: "Put the block's text back in the Org buffer, and go back there.",
  run: () => exit(false),
});
const abortCommand = e8.defineCommand({
  name: "org-edit-src-abort",
  doc: "Go back to the Org buffer, leaving the block as it was.",
  run: () => exit(true),
});
const saveCommand = e8.defineCommand({
  name: "org-edit-src-save",
  doc: "Put the block's text back in the Org buffer and save that, staying here.",
  run: () => {
    const edit = edits.get(e8.currentBuffer());
    if (!edit) e8.userError("Not in a sub-editing buffer");
    writeBack(edit, contentsForWriteBack(edit));
    e8.setBufferModified(false);
    e8.withCurrentBuffer(edit.source, () => e8.call("save-buffer"));
  },
});

const orgSrcMode = e8.defineMinorMode({
  name: "org-src-mode",
  lighter: " OrgSrc",
  doc: "On in a buffer editing an Org block's text: C-c ' puts it back, C-c C-k leaves the block as it was, C-x C-s saves.",
  bindings: { "C-c '": exitCommand, "C-c C-k": abortCommand, "C-x C-s": saveCommand },
  onChange: (enabled) => {
    if (enabled && e8.variable("org-edit-src-persistent-message") === true) {
      e8.makeLocalVariable("header-line-format");
      e8.setVariable("header-line-format", "Edit, then exit with ‘C-c '’ or abort with ‘C-c C-k’");
    }
  },
});

e8.defineCommand({
  name: "org-edit-src-code",
  doc: "Edit the source or example block at point in a buffer of its own, in its language's mode. C-c ' there puts it back.",
  run: () => editSrcCode(),
});

const editSpecial = e8.defineCommand({
  name: "org-edit-special",
  doc: "Edit the element at point in a buffer of its own: a source or example block in its language's mode.",
  run: () => {
    if (blockAt()) editSrcCode();
    else e8.userError("No special environment to edit here");
  },
});

e8.defineKey("org-mode-map", "C-c '", editSpecial);

/**
 * Fontifies a source block's text from start to end as its language's mode
 * does, as org-src-font-lock-fontify-block: in a buffer of its own, whose
 * faces are copied back. False if there is no mode for the language.
 */
e8.defun("org-src-font-lock-fontify-block", (lang: e8.Value, start: e8.Value, end: e8.Value) => {
  const mode = langMode(String(lang));
  if (!e8.commandNames().includes(mode)) return false;
  const from = Number(start);
  const text = e8.bufferSubstringNoProperties(from, Number(end));
  const name = ` *org-src-fontification:${mode}*`;
  const fresh = e8.getBuffer(name) === undefined;
  e8.getBufferCreate(name);
  const runs: [number, number, e8.Value][] = [];
  e8.withCurrentBuffer(name, () => {
    if (fresh) e8.bufferDisableUndo();
    eraseBuffer();
    e8.insert(`${text} `);
    if (e8.variable("org-src--fontification-mode") !== mode) {
      e8.call(mode as e8.CommandName);
      e8.makeLocalVariable("org-src--fontification-mode");
      e8.setVariable("org-src--fontification-mode", mode);
    }
    e8.call("font-lock-ensure");
    const size = e8.bufferSize() - 1;
    // A tree-sitter mode's faces come from its syntax tree, not properties, until asked for.
    if (e8.treesitLanguage() !== undefined) e8.treesitFontLockFontifyRegion(0, size);
    for (let p = 0; p < size; ) {
      const next = Math.min(e8.nextSinglePropertyChange(p, "face", size) ?? size, size);
      const face = e8.getTextProperty(p, "face");
      if (face !== undefined && face !== null && face !== false) runs.push([p, next, face]);
      p = next;
    }
    e8.setBufferModified(false);
  });
  for (const [a, b, face] of runs) e8.putTextProperty(from + a, from + b, "face", face);
  return true;
});
