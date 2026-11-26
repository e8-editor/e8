// Editing an element's text in a buffer of its own, after Org's org-src.el:
// C-c ' in a source, example, export or comment block, a fixed-width area
// or a LaTeX environment shows its text in *Org Src ...*, in the mode for
// its language; C-c ' there puts it back and C-c C-k leaves it as it was.
// C-c ' elsewhere does what Org's org-edit-special does: a table's
// formulas, an included file, a planning line's dates, a timestamp, a link.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { barfIfBufferReadOnly, eraseBuffer, PerBuffer, truthy } from "subr";
import { type Elem, elementAt, endBeforeBlank, withAffiliated } from "org-element";
import { orgRegionActive } from "org-macs";
import { linkHere } from "ol";
import { footnoteToEdit } from "org-footnote";
import { expectedIndent, openLink } from "org";
import { commentOrUncommentRegion } from "newcomment";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("org-src-lang-modes", [
  ["C", "c"], ["C++", "c++"], ["cpp", "c++"], ["elisp", "emacs-lisp"], ["shell", "sh"], ["bash", "sh"], ["sh", "sh"],
  ["calc", "fundamental"], ["dot", "fundamental"], ["sqlite", "sql"], ["toml", "conf-toml"],
], "The major modes of source blocks' languages, as [language, mode] lists, the mode without -mode; others are LANGUAGE-mode.");
defvar("org-src-window-setup", "reorganize-frame", "Where C-c ' shows a block's text: reorganize-frame, current-window, other-window, split-window-below or split-window-right.");
defvar("org-src-tab-acts-natively", true, "Whether TAB in a source block indents its line as the language's mode would.");
defvar("org-src-fontify-natively", true, "Whether a source block's text has the faces its language's mode gives it.");
defvar(
  "org-src-block-faces",
  [],
  'Faces for source blocks\' text by language, as ["language", face] lists: a face\'s name, or an anonymous face, a list of attributes such as [":background", "#EEE2FF"]. "" is for blocks with no language.',
);
defvar("org-edit-src-persistent-message", true, "Whether the block's buffer says in its header line how to finish.");
defvar("org-edit-fixed-width-region-mode", "artist-mode", "The major mode C-c ' edits a fixed-width area in.");
defvar("org-src-ask-before-returning-to-edit-buffer", true, "Whether C-c ' asks before going back to an edit of the same text already under way; no discards that edit.");

/** What a block's buffer edits: where in which buffer, and how its text goes back. */
interface Edit {
  beg: e8.Marker;
  end: e8.Marker;
  source: string;
  blockIndentation: number;
  contentIndentation: number;
  preserve: boolean;
  windows?: e8.WindowConfiguration;
  /** What becomes of the text before it goes back, as org-src--allow-write-back's function: commas before lines Org would read, ": " before a fixed-width area's lines. */
  writeBack?: (text: string) => string;
  /** The Org buffer's tab width if it indents with tabs, else 0, as org-src--tab-width. */
  tabWidth: number;
  /** Whether point stays where it is on leaving, as org-src--remote, for a footnote's definition edited from its reference. */
  remote?: boolean;
  /** Whether the first line is left as it is, as for a LaTeX fragment, which starts in a paragraph's text. */
  keepFirstLine?: boolean;
}

/** What an element editor asks of the edit buffer beyond its text and mode. */
interface EditOptions {
  writeBack?: (text: string) => string;
  /** Read-only stretches of the text, as Org marks a footnote's label: from, to, the message, and whether it sticks to text typed before it and after it. */
  readOnly?: [number, number, string, boolean, boolean][];
  remote?: boolean;
  keepFirstLine?: boolean;
}

/** An element's text to edit, as org-src--contents-area gives it, and the element's own indentation. */
interface Datum {
  type: string;
  beg: number;
  end: number;
  contents: string;
  blockIndentation: number;
  preserve: boolean;
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
export function langMode(lang: string): string {
  const alist = e8.variable("org-src-lang-modes");
  const entry = Array.isArray(alist) ? (alist.find((e) => Array.isArray(e) && e[0] === lang) as e8.Value[] | undefined) : undefined;
  return `${entry ? String(entry[1]) : lang}-mode`;
}

/** A line's indentation in columns, tabs to the next multiple of eight. */
function lineIndentation(l: string): number {
  let col = 0;
  for (const c of /^[ \t]*/.exec(l)![0]) col = c === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
  return col;
}

/**
 * Takes the indentation the non-blank lines share off them, as
 * org-do-remove-indentation: nothing if one has none; a blank line's
 * blanks go; a tab spanning the column stays, as move-to-column with
 * indent-tabs-mode puts spaces before it rather than splitting it.
 */
function removeCommonIndentation(text: string): string {
  const lines = text.split("\n");
  // The least indentation, starting from the buffer's size, as Org starts it from point-max.
  let n = charCountOf(text) + 1;
  for (const l of lines) {
    if (!/^[ \t]*\S/.test(l)) continue;
    const ind = lineIndentation(l);
    if (ind === 0) return text;
    n = Math.min(n, ind);
  }
  return lines.map((l) => {
    if (!/\S/.test(l)) return lineIndentation(l) < n ? "" : cutColumns(l, n);
    return cutColumns(l, n);
  }).join("\n");
}

/** A line without its first n columns of indentation, a tab that spans the column kept. */
function cutColumns(l: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < l.length && col < n && (l[i] === " " || l[i] === "\t")) {
    const next = l[i] === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
    if (next > n) break;
    col = next;
    i++;
  }
  return l.slice(i);
}

/** Lines after the first without n columns of indentation, as org-do-remove-indentation with N and SKIP-FL. */
function removeColumnsAfterFirst(text: string, n: number): string {
  if (n === 0) return text;
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const ind = lineIndentation(lines[i]);
    if (ind < n) {
      if (/\S/.test(lines[i])) break;
      lines[i] = "";
    } else lines[i] = cutColumns(lines[i], n);
  }
  return lines.join("\n");
}

/** How many characters a string has, as Emacs counts them. */
function charCountOf(s: string): number {
  return [...s].length;
}

/** Indentation to a column, with tabs if the Org buffer indents with them, as indent-to makes it there. */
function indentString(offset: number, tabWidth: number): string {
  if (tabWidth <= 0) return " ".repeat(offset);
  return "\t".repeat(Math.floor(offset / tabWidth)) + " ".repeat(offset % tabWidth);
}

/** Shows a block's buffer, or the Org buffer again, as org-src-switch-to-buffer does for org-src-window-setup. */
function switchTo(buffer: string, context: "edit" | "exit"): void {
  const setup = String(e8.variable("org-src-window-setup") ?? "reorganize-frame");
  if (setup === "current-window") e8.call("switch-to-buffer", buffer);
  else if (setup === "other-window") {
    const current = e8.selectedWindow();
    e8.call("switch-to-buffer-other-window", buffer);
    // As quit-restore-window takes the edit buffer's window away.
    if (context === "exit" && e8.windowList().length > 1 && e8.windowLiveP(current)) e8.deleteWindow(current);
  }
  else if (setup === "split-window-below" || setup === "split-window-right") {
    if (context === "edit") e8.selectWindow(e8.splitWindow(undefined, setup === "split-window-below" ? "below" : "right"));
    e8.call("switch-to-buffer", buffer);
  } else if (context === "edit") {
    if (e8.windowList().length === 1) e8.splitWindow(undefined, "below");
    e8.call("switch-to-buffer-other-window", buffer);
  } else e8.call("switch-to-buffer", buffer);
}

type Block = NonNullable<ReturnType<typeof blockAt>>;

/** Where a position is within an area, by line and by column from the line's end, or the end, as org-src--coordinates. */
function coordinates(pos: number, beg: number, end: number): [number, number] | "end" {
  if (pos >= end) return "end";
  return e8.saveRestriction(() => {
    e8.widen();
    const p = Math.max(beg, pos);
    const line = e8.lineOf(p);
    return [line - e8.lineOf(beg), p - Math.min(end, e8.lineEnd(line))];
  });
}

/** Moves to coordinates within an area, as org-src--goto-coordinates. */
function gotoCoordinates(c: [number, number] | "end", beg: number, end: number): void {
  if (c === "end") {
    e8.gotoChar(Math.max(end - 1, beg));
    return;
  }
  const target = e8.saveRestriction(() => {
    e8.widen();
    const line = Math.min(e8.lineOf(beg) + c[0], e8.lineCount() - 1);
    return Math.max(e8.lineStart(line), Math.min(end, e8.lineEnd(line)) + c[1]);
  });
  e8.gotoChar(target);
}

/**
 * Makes the buffer that edits an element's text, as org-src--edit-element
 * does: its text without the indentation its lines share, in `mode`, point
 * where it was in the element. The current buffer stays as it was.
 */
function openElement(d: Datum, base: string, mode: string | undefined, options: EditOptions | ((text: string) => string) = {}): { name: string; edit: Edit } {
  const o: EditOptions = typeof options === "function" ? { writeBack: options } : options;
  const writeBack = o.writeBack;
  const source = e8.bufferName();
  const coords = coordinates(e8.point(), d.beg, d.end);
  // The region, if active and in the element, as org-src--edit-element carries it in.
  const mark = e8.mark();
  const markCoords = orgRegionActive() && mark !== undefined && mark >= d.beg && mark <= d.end ? coordinates(mark, d.beg, d.end) : undefined;
  // A fragment's lines after its first lose the element's indentation, the rest what they share.
  const text = d.preserve ? d.contents : o.keepFirstLine ? removeColumnsAfterFirst(d.contents, d.blockIndentation) : removeCommonIndentation(d.contents);
  const tabWidth = truthy(e8.variable("indent-tabs-mode") ?? null) ? Number(e8.variable("tab-width") ?? 8) : 0;
  const edit: Edit = {
    beg: e8.makeMarker(d.beg),
    end: e8.makeMarker(d.end, { advances: true }),
    source,
    blockIndentation: d.blockIndentation,
    contentIndentation: d.type === "src-block" || d.type === "example-block" ? Number(e8.variable("org-edit-src-content-indentation") ?? 2) : 0,
    preserve: d.preserve,
    writeBack,
    tabWidth,
    remote: o.remote,
    keepFirstLine: o.keepFirstLine,
  };
  // A buffer of its own, as generate-new-buffer names it, <2> after another's.
  const name = e8.generateNewBufferName(base);
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.insert(text);
    for (const [from, to, message, front, rear] of o.readOnly ?? []) {
      e8.putTextProperty(from, to, "read-only", message);
      e8.putTextProperty(from, to, "front-sticky", front);
      e8.putTextProperty(from, to, "rear-nonsticky", rear);
    }
    // No undoing back to the empty buffer, as Org clears the undo list.
    e8.bufferDisableUndo();
    e8.bufferEnableUndo();
    if (mode !== undefined) {
      if (e8.commandNames().includes(mode)) e8.letBind({ "org-inhibit-startup": true }, () => e8.call(mode as e8.CommandName));
      // As Org reports a mode that fails to start, and goes on.
      else e8.message(`Initialization fails with: "Symbol\u2019s function definition is void: ${mode}"`);
    }
    edits.set(e8.currentBuffer(), edit);
    e8.callWithPrefix(1, orgSrcMode);
    e8.setBufferModified(false);
    if (o.remote) {
      // At the first text that may be edited, after blanks, as Org puts point remotely.
      let q = 0;
      while (q < e8.bufferSize() && truthy(e8.getTextProperty(q, "read-only") ?? null)) q++;
      e8.gotoChar(q);
      e8.skipCharsForward(" \r\t\n");
    } else {
      if (markCoords !== undefined) {
        gotoCoordinates(markCoords, 0, e8.bufferSize());
        e8.pushMark(e8.point(), { activate: true });
      }
      gotoCoordinates(coords, 0, e8.bufferSize());
    }
  });
  return { name, edit };
}

/** The text of a source or example block to edit, as org-src--contents-area gives a block's. */
function blockDatum(block: Block): Datum {
  const beg = e8.lineStart(block.begin + 1);
  const end = e8.lineStart(block.end);
  return {
    type: block.kind === "src" ? "src-block" : "example-block",
    beg,
    end,
    // Their value, commas before lines Org would read taken off, as Org's parser gives it.
    contents: unescapeCode(e8.bufferSubstringNoProperties(beg, end)),
    blockIndentation: block.indent,
    preserve: e8.variable("org-src-preserve-indentation") === true || /(^|\s)-i(\s|$)/.test(block.switches),
  };
}

/**
 * Makes the buffer that edits a block, in its language's mode, as
 * org-edit-src-code does through org-src--edit-element.
 */
function openEdit(block: Block): { name: string; edit: Edit } {
  const lang = block.kind === "src" ? block.lang ?? "" : "example";
  const mode = block.kind === "src" ? langMode(lang) : undefined;
  if (mode !== undefined && !e8.commandNames().includes(mode)) e8.signal("error", `No such language mode: ${mode}`);
  return openElement(blockDatum(block), `*Org Src ${e8.bufferName()}[ ${lang} ]*`, mode, escapeCode);
}

/** Edits the block at point in its language's mode, as org-edit-src-code. */
function editSrcCode(): void {
  // From the block's affiliated keywords too, as #+NAME:, which Org's element includes.
  let block = blockAt();
  if (!block) {
    const e = withAffiliated(elementAt(e8.point()));
    if (e && (e.type === "src-block" || e.type === "example-block") && e.postAffiliated !== undefined) {
      block = e8.saveExcursion(() => {
        e8.gotoChar(e.postAffiliated!);
        return blockAt();
      });
    }
  }
  if (!block) e8.userError("Not in a source or example block");
  const d = blockDatum(block);
  if (returnToExisting(d.beg, d.end)) return;
  const windows = savedWindows();
  const { name, edit } = openEdit(block);
  edit.windows = windows;
  switchTo(name, "edit");
}

/** The windows to put back on leaving, as org-src--saved-temp-window-config keeps them for the setups that split. */
function savedWindows(): e8.WindowConfiguration | undefined {
  const setup = String(e8.variable("org-src-window-setup") ?? "reorganize-frame");
  return ["reorganize-frame", "split-window-below", "split-window-right"].includes(setup) ? e8.currentWindowConfiguration() : undefined;
}

/**
 * Goes back to an edit of the same area already under way, as
 * org-src--edit-element does, asking first as
 * org-src-ask-before-returning-to-edit-buffer says; no discards it.
 */
function returnToExisting(beg: number, end: number): boolean {
  const source = e8.bufferName();
  const existing = e8.bufferList().find((b) => {
    const e = e8.getBuffer(b) && edits.get(b);
    return e !== undefined && e8.markerBuffer(e.beg) === source && e8.markerPosition(e.beg) === beg && e8.markerPosition(e.end) === end;
  });
  if (existing === undefined) return false;
  if (!truthy(e8.variable("org-src-ask-before-returning-to-edit-buffer") ?? null) || e8.yOrNP("Return to existing edit buffer ([n] will revert changes)? ")) {
    switchTo(existing, "edit");
    return true;
  }
  const old = edits.get(existing);
  if (old) {
    e8.deleteMarker(old.beg);
    e8.deleteMarker(old.end);
  }
  e8.withCurrentBuffer(existing, () => {
    edits.delete(e8.currentBuffer());
    e8.setBufferModified(false);
  });
  e8.call("kill-buffer", existing);
  return false;
}

/** The block's buffer's text as it goes back: each non-blank line indented by the block's and its content's indentation. */
function contentsForWriteBack(edit: Edit): string {
  let text = e8.bufferSubstringNoProperties(0, e8.bufferSize());
  if (edit.writeBack) text = edit.writeBack(text);
  const offset = edit.preserve ? 0 : edit.blockIndentation + edit.contentIndentation;
  const indent = indentString(offset, edit.tabWidth);
  return offset > 0 ? text.split("\n").map((l, i) => (l === "" || (i === 0 && edit.keepFirstLine) ? l : indent + l)).join("\n") : text;
}

/** Puts the block's buffer's text back in place of the block's, if it changed. */
function writeBack(edit: Edit, text: string): void {
  e8.withCurrentBuffer(edit.source, () => {
    const beg = e8.markerPosition(edit.beg) ?? 0;
    const end = e8.markerPosition(edit.end) ?? beg;
    if (e8.bufferSubstringNoProperties(beg, end) === text) return;
    // Wherever the Org buffer is narrowed to now, as org-edit-src-exit
    // narrows to the block itself to put the text back.
    // Only what differs changes, so point and markers in the block keep their
    // places, as org-replace-buffer-contents writes it back.
    const scratch = e8.generateNewBufferName(" *org-src-write-back*");
    e8.getBufferCreate(scratch);
    try {
      e8.withCurrentBuffer(scratch, () => e8.insert(text));
      e8.saveExcursion(() =>
        e8.saveRestriction(() => {
          e8.widen();
          // From the block's start after an undo boundary, as org-edit-src-exit puts one there, so undoing it comes back there.
          e8.gotoChar(beg);
          e8.undoBoundary();
          const expectingBol = beg === e8.lineStart(e8.lineOf(beg));
          e8.narrowToRegion(beg, end);
          e8.replaceBufferContents(scratch, 0.1);
          // Ending in a newline, as Org adds one after text that does not.
          const stop = e8.pointMax();
          e8.widen();
          if (expectingBol && stop > beg && e8.bufferText(stop - 1, stop) !== "\n") {
            e8.gotoChar(stop);
            e8.insert("\n");
          }
        }),
      );
    } finally {
      e8.call("kill-buffer", scratch);
    }
  });
}

/** Leaves the block's buffer for the Org buffer, writing its text back unless `abort`, as org-edit-src-exit. */
function exit(abort: boolean): void {
  const edit = edits.get(e8.currentBuffer());
  if (!edit) e8.signal("error", "Not in a sub-editing buffer");
  const at = coordinates(e8.point(), 0, e8.bufferSize());
  const text = contentsForWriteBack(edit);
  const name = e8.bufferName();
  if (!e8.bufferList().includes(edit.source)) e8.signal("error", "Source buffer disappeared.  Aborting");
  if (!abort) writeBack(edit, text);
  e8.setBufferModified(false);
  edits.delete(e8.currentBuffer());
  if (edit.windows) e8.setWindowConfiguration(edit.windows);
  switchTo(edit.source, "exit");
  e8.call("kill-buffer", name);
  if (edit.remote) {
    e8.deleteMarker(edit.beg);
    e8.deleteMarker(edit.end);
  } else returnPoint(edit, abort ? undefined : at);
}

/** Puts point back in the Org buffer where it was in the block's buffer, as org-src--goto-coordinates, and frees the edit's markers. */
function returnPoint(edit: Edit, at: [number, number] | "end" | undefined): void {
  const beg = e8.markerPosition(edit.beg) ?? 0;
  if (at === undefined) e8.gotoChar(beg);
  else gotoCoordinates(at, beg, e8.markerPosition(edit.end) ?? beg);
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
  let at: [number, number] | "end" = [0, 0];
  let text = "";
  e8.withCurrentBuffer(name, () => {
    try {
      body();
    } finally {
      at = coordinates(e8.point(), 0, e8.bufferSize());
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

/**
 * The element point is in, for C-c ', as org-element-at-point gives it: on
 * affiliated keywords, as #+NAME:, the element they belong to.
 */
function elementHere(): Elem | undefined {
  return withAffiliated(elementAt(e8.point()));
}

/** Whether point is in an Org table, a row or its keywords and #+TBLFM: lines, where Org's C-c ' edits the formulas. */
function orgTableHere(): boolean {
  if (!e8.derivedModeP("org-mode")) return false;
  for (let e = elementHere(); e; e = e.parent) {
    if (e.type === "table-row") return true;
    if (e.type === "table") return e.tableType !== "table.el";
  }
  return false;
}

/** Whether point is on an element, not the blank lines after it, as org-src--on-datum-p. */
function onDatum(e: Elem): boolean {
  return e8.point() >= e.begin && e8.point() <= endBeforeBlank(e);
}

/** An element's indentation, as org-current-text-indentation at its start. */
function indentationAt(pos: number): number {
  return /^[ \t]*/.exec(e8.lineText(e8.lineOf(pos)))![0].replace(/\t/g, "        ").length;
}

const ESCAPE = /^([ \t]*)(,*(?:\*|#\+))/gm;
const UNESCAPE = /^([ \t]*,*),((?:\*|#\+))/gm;

/** Puts a comma before lines Org would read as its own, as org-escape-code-in-region. */
function escapeCode(text: string): string {
  return text.replace(ESCAPE, "$1,$2");
}

/** Takes the comma off lines escaped so, as org-unescape-code-in-string. */
function unescapeCode(text: string): string {
  return text.replace(UNESCAPE, "$1$2");
}

/** The area between a block's #+begin and #+end lines, as org-src--contents-area finds a block's. */
function blockArea(e: Elem): { beg: number; end: number } {
  const begin = e.postAffiliated ?? e.begin;
  return { beg: e8.lineStart(Math.min(e8.lineOf(begin) + 1, e8.lineCount() - 1)), end: e8.lineStart(e8.lineOf(endBeforeBlank(e))) };
}

/** The area from an element's first line to the line after its last, as org-src--contents-area finds a fixed-width area's or a LaTeX environment's. */
function wholeArea(e: Elem): { beg: number; end: number } {
  const last = e8.lineOf(endBeforeBlank(e));
  return { beg: e.postAffiliated ?? e.begin, end: last + 1 < e8.lineCount() ? e8.lineStart(last + 1) : e8.bufferSize() };
}

/** The element of a type point is on, or Org's error for not being in one. */
function elementOfType(type: string, error: string): Elem {
  const e = elementHere();
  if (!e || e.type !== type || !onDatum(e)) e8.userError(error);
  return e!;
}

/** Edits an export block's text in the mode for its backend, as org-edit-export-block. */
function editExportBlock(): void {
  const e = elementOfType("export-block", "Not in an export block");
  const first = e8.lineText(e8.lineOf(e.postAffiliated ?? e.begin));
  const type = (/^[ \t]*#\+begin_export[ \t]+(\S+)/i.exec(first)?.[1] ?? "fundamental").toLowerCase();
  const mode = langMode(type);
  if (!e8.commandNames().includes(mode)) e8.signal("error", `No such language mode: ${mode}`);
  const { beg, end } = blockArea(e);
  const d: Datum = { type: "export-block", beg, end, contents: unescapeCode(e8.bufferSubstringNoProperties(beg, end)), blockIndentation: indentationAt(e.begin), preserve: false };
  openAndShow(d, `*Org Src ${e8.bufferName()}[ ${type} ]*`, mode, escapeCode);
}

/** Edits a comment block's text in Org mode, as org-edit-comment-block. */
function editCommentBlock(): void {
  const e = elementOfType("comment-block", "Not in a comment block");
  const { beg, end } = blockArea(e);
  const d: Datum = { type: "comment-block", beg, end, contents: unescapeCode(e8.bufferSubstringNoProperties(beg, end)), blockIndentation: indentationAt(e.begin), preserve: false };
  openAndShow(d, `*Org Src ${e8.bufferName()}[ org ]*`, "org-mode", escapeCode);
}

/** Edits a fixed-width area without its colons, as org-edit-fixed-width-region. */
function editFixedWidth(): void {
  const e = elementOfType("fixed-width", "Not in a fixed-width area");
  const { beg, end } = wholeArea(e);
  const value = e8.bufferSubstringNoProperties(beg, e8.lineEnd(e8.lineOf(endBeforeBlank(e)))).replace(/^[ \t]*: ?/gm, "");
  const d: Datum = { type: "fixed-width", beg, end, contents: value, blockIndentation: indentationAt(e.begin), preserve: false };
  const mode = e8.variable("org-edit-fixed-width-region-mode");
  openAndShow(d, `*Org Src ${e8.bufferName()}[ Fixed Width ]*`, typeof mode === "string" ? mode : undefined, (text) =>
    // ": " at the start of each line, as Org inserts it line by line up to the end.
    text.split("\n").map((l, i, all) => (i === all.length - 1 && l === "" ? l : `: ${l}`)).join("\n"),
  );
}

/** Edits a LaTeX environment in the mode for LaTeX, as org-edit-latex-environment. */
function editLatexEnvironment(): void {
  const e = elementOfType("latex-environment", "Not in a LaTeX environment");
  const { beg, end } = wholeArea(e);
  const d: Datum = { type: "latex-environment", beg, end, contents: e8.bufferSubstringNoProperties(beg, end), blockIndentation: indentationAt(e.begin), preserve: false };
  // As Org starts the mode only if there is one.
  const mode = langMode("latex");
  openAndShow(d, `*Org Src ${e8.bufferName()}[ LaTeX environment ]*`, e8.commandNames().includes(mode) ? mode : undefined, (t) => t);
}

/** Opens an element's edit buffer and shows it, as org-src--edit-element does for the element editors. */
function openAndShow(d: Datum, name: string, mode: string | undefined, writeBack: EditOptions | ((text: string) => string)): void {
  if (returnToExisting(d.beg, d.end)) return;
  const windows = savedWindows();
  const opened = openElement(d, name, mode, writeBack);
  opened.edit.windows = windows;
  switchTo(opened.name, "edit");
}

/** Opens the file a #+INCLUDE:, #+SETUPFILE: or #+BIBLIOGRAPHY: line names, as org-edit-special does through a file link. */
function editKeyword(line: string): void {
  const m = /^[ \t]*#\+(\S+?):[ \t]*(.*?)[ \t]*$/.exec(line);
  const key = m?.[1].toUpperCase() ?? "";
  if (!["BIBLIOGRAPHY", "INCLUDE", "SETUPFILE"].includes(key)) e8.userError("No special environment to edit here");
  const value = m![2];
  if (!/\S/.test(value)) e8.userError("No file to edit");
  const f = /^"(.*?)"|\S+/.exec(value)!;
  const file = f[1] ?? f[0];
  if (/^[a-z][-+.a-z0-9]*:\/\//i.test(file)) e8.userError("Files located with a URL cannot be edited");
  openLink({ start: 0, end: 0, path: `file:${e8.expandFileName(file)}`, description: undefined, kind: "bracket" });
}

e8.defineCommand({
  name: "org-edit-export-block",
  doc: "Edit the export block at point in a buffer of its own, in the mode for its backend. C-c ' there puts it back.",
  run: () => editExportBlock(),
});

e8.defineCommand({
  name: "org-edit-comment-block",
  doc: "Edit the comment block at point in a buffer of its own, in Org mode. C-c ' there puts it back.",
  run: () => editCommentBlock(),
});

e8.defineCommand({
  name: "org-edit-fixed-width-region",
  doc: "Edit the fixed-width area at point, its lines without their colons, in the mode org-edit-fixed-width-region-mode names. C-c ' there puts it back.",
  run: () => editFixedWidth(),
});

e8.defineCommand({
  name: "org-edit-latex-environment",
  doc: "Edit the LaTeX environment at point in a buffer of its own, in the mode for LaTeX if there is one. C-c ' there puts it back.",
  run: () => editLatexEnvironment(),
});

const editSpecial = e8.defineCommand({
  name: "org-edit-special",
  doc:
    "Edit the element at point in a buffer of its own: a source, example, export or comment block, a fixed-width area or a LaTeX environment; " +
    "a table's formulas; the file a #+INCLUDE: line names; a planning line's dates; a timestamp; a link.",
  run: () => {
    barfIfBufferReadOnly();
    const e = elementHere();
    switch (e?.type) {
      case "src-block":
      case "example-block":
        editSrcCode();
        return;
      case "keyword":
        editKeyword(e8.lineText(e8.lineOf(e.postAffiliated ?? e.begin)));
        return;
      case "table":
      case "table-row":
        if (orgTableHere()) e8.call("org-table-edit-formulas");
        else e8.userError("No special environment to edit here");
        return;
      case "export-block":
        editExportBlock();
        return;
      case "comment-block":
        editCommentBlock();
        return;
      case "fixed-width":
        editFixedWidth();
        return;
      case "latex-environment":
        editLatexEnvironment();
        return;
      case "planning": {
        const text = e8.lineText(e8.lineOf(e.begin));
        if (/\bDEADLINE:/.test(text)) e8.callInteractively("org-deadline");
        if (/\bSCHEDULED:/.test(text)) e8.callInteractively("org-schedule");
        return;
      }
    }
    // Objects, only in what Org parses for them: a paragraph, a heading's title, a table row, a verse block.
    const headingLine = /^\*+ /.test(e8.lineText(e8.lineOf(e8.point())));
    if (!headingLine && !["paragraph", "table-row", "table", "verse-block"].includes(e?.type ?? "")) e8.userError("No special environment to edit here");
    // The innermost object, as org-element-context gives it: what an inline footnote holds before the footnote.
    if (inlineSrcAt()) {
      editInlineSrcCode();
      return;
    }
    if (latexFragmentAt()) {
      editLatexFragment();
      return;
    }
    const ts = timestampAtPoint();
    if (ts !== undefined) {
      e8.callInteractively(ts ? "org-timestamp" : "org-timestamp-inactive");
      return;
    }
    if (linkHere()) {
      e8.callInteractively("ffap");
      return;
    }
    if (footnoteToEdit()?.ref) {
      editFootnoteReference();
      return;
    }
    e8.userError("No special environment to edit here");
  },
});

/** Whether point is on a timestamp, active or inactive, as org-element-context finds one: true for active, false for inactive. */
function timestampAtPoint(): boolean | undefined {
  const line = e8.lineText(e8.lineOf(e8.point()));
  const col = e8.point() - e8.lineStart(e8.lineOf(e8.point()));
  for (const m of line.matchAll(/<\d{4}-\d{2}-\d{2}[^>\n]*>(?:--<\d{4}-\d{2}-\d{2}[^>\n]*>)?|\[\d{4}-\d{2}-\d{2}[^\]\n]*\](?:--\[\d{4}-\d{2}-\d{2}[^\]\n]*\])?/g)) {
    const at = m.index ?? 0;
    // With the blanks after it, as an object's end takes them.
    const blanks = /^[ \t]*/.exec(line.slice(at + m[0].length))![0].length;
    // An inactive range is no inactive timestamp to Org, which changes it with org-timestamp.
    if (at <= col && col < at + m[0].length + blanks) return m[0].startsWith("<") || m[0].includes("--");
  }
  return undefined;
}

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

/**
 * Whether the block at point has a language whose mode E8 has. Without one,
 * Org's edit buffer does not open and its org-edit-src-exit then says
 * "Not in a sub-editing buffer", which the comment commands signal too.
 */
function editableHere(): boolean {
  const block = blockAt();
  if (!block || block.kind !== "src") return true;
  const mode = langMode(block.lang ?? "");
  return mode === undefined || e8.commandNames().includes(mode);
}

// M-; and the region's comments in a source block, as its language comments, as Org's comment functions do it in the edit buffer.
e8.defun("org-src--comment-dwim", () => {
  // Point at the line's end first, as comment-dwim's comment-indent goes there before Org fails.
  if (!editableHere()) {
    e8.gotoChar(e8.lineEnd(e8.lineOf(e8.point())));
    e8.signal("error", "Not in a sub-editing buffer");
  }
  doInEditBuffer(() => e8.funcallInteractively("comment-dwim"));
  return true;
});
e8.defun("org-src--comment-or-uncomment-region", (offset: number) => {
  if (!editableHere()) e8.signal("error", "Not in a sub-editing buffer");
  doInEditBuffer(() => commentOrUncommentRegion(e8.point(), e8.point() + offset, null));
  return true;
});

/**
 * Fills the source block at point in its language's mode, in its edit
 * buffer, as org-fill-element does for a src-block: the paragraph there,
 * or the region if it is active there.
 */
e8.defun("org-src--fill-paragraph", (justify?: e8.Value) => {
  if (!editableHere()) e8.signal("error", "Not in a sub-editing buffer");
  doInEditBuffer(() => e8.callWithPrefix(justify === null || justify === undefined || justify === false ? null : 4, "fill-paragraph"));
  return true;
});

// Objects C-c ' edits, after org-src.el's org-edit-footnote-reference,
// org-edit-latex-fragment and org-edit-inline-src-code: each in a buffer of
// its own, as the elements are.

/** An object found on point's line: where it begins, ends, and ends with the blanks after it. */
interface ObjectSpan {
  begin: number;
  end: number;
  objectEnd: number;
  match: RegExpExecArray;
}

/** Where =verbatim= and ~code~ are on a line, which hold no other objects, as Org's emphasis markers find them. */
function verbatimSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of line.matchAll(/(^|[\s\-('"{])([=~])([^\s]|[^\s].*?[^\s])\2(?=[\s\-.,:!?;'")}\[\\]|$)/g)) {
    const at = (m.index ?? 0) + m[1].length;
    spans.push([at, at + m[0].length - m[1].length]);
  }
  return spans;
}

/** The first match of a pattern on point's line whose object, blanks after it included, holds point, as org-element-context finds one. */
function objectOnLine(re: RegExp, accept: (m: RegExpExecArray, line: string) => boolean = () => true): ObjectSpan | undefined {
  const l = e8.lineOf(e8.point());
  const line = e8.lineText(l);
  const col = e8.point() - e8.lineStart(l);
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const verbatim = verbatimSpans(line);
  for (const m of line.matchAll(g)) {
    const at = m.index ?? 0;
    if (!accept(m as RegExpExecArray, line)) continue;
    if (verbatim.some(([a, b]) => at > a && at < b)) continue;
    const blanks = /^[ \t]*/.exec(line.slice(at + m[0].length))![0].length;
    if (at <= col && col < at + m[0].length + Math.max(blanks, 1)) {
      const begin = e8.lineStart(l) + [...line.slice(0, at)].length;
      const end = begin + [...m[0]].length;
      return { begin, end, objectEnd: end + blanks, match: m as RegExpExecArray };
    }
  }
  return undefined;
}

/** Where the bracket opened at i closes, nested ones balanced, as org-element--parse-paired-brackets finds it. */
function pairedClose(text: string, i: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    if (text[k] === open) depth++;
    else if (text[k] === close && --depth === 0) return k;
  }
  return undefined;
}

/**
 * The inline source block on point, src_LANG[HEADERS]{CODE}, its brackets
 * and braces balanced and over the paragraph's lines, as Org's parser finds
 * one; none in a table, whose cells hold no inline source code.
 */
function inlineSrcAt(): ObjectSpan | undefined {
  const p = e8.point();
  const e = elementAt(p);
  if (e && (e.type === "table" || e.type === "table-row")) return undefined;
  const heading = /^\*+ /.test(e8.lineText(e8.lineOf(p)));
  const from = !heading && e?.type === "paragraph" ? (e.contentsBegin ?? e.begin) : e8.lineStart(e8.lineOf(p));
  const to = !heading && e?.type === "paragraph" ? (e.contentsEnd ?? e.end) : e8.lineEnd(e8.lineOf(p));
  const text = e8.bufferText(from, to);
  const verbatim = text.split("\n").length === 1 ? verbatimSpans(text) : [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])src_([^ \t\n[{]+)/gu)) {
    let i = (m.index ?? 0) + m[0].length;
    let headers: string | undefined;
    if (text[i] === "[") {
      const k = pairedClose(text, i, "[", "]");
      if (k === undefined || text.slice(i, k).includes("\n")) continue;
      headers = text.slice(i, k + 1);
      i = k + 1;
    }
    if (text[i] !== "{") continue;
    const k = pairedClose(text, i, "{", "}");
    if (k === undefined) continue;
    if (verbatim.some(([a, b]) => (m.index ?? 0) > a && (m.index ?? 0) < b)) continue;
    const begin = from + [...text.slice(0, m.index ?? 0)].length;
    const end = from + [...text.slice(0, k + 1)].length;
    const blanks = /^[ \t]*/.exec(text.slice(k + 1))![0].length;
    if (p >= begin && p < end + Math.max(blanks, 1)) {
      const match = [text.slice(m.index ?? 0, k + 1), m[1], headers as string, text.slice(i + 1, k)] as unknown as RegExpExecArray;
      return { begin, end, objectEnd: end + blanks, match };
    }
  }
  return undefined;
}

/** The LaTeX fragment on point: $...$, $$...$$, \(...\), \[...\], or a command with arguments, as Org's parser finds one. */
function latexFragmentAt(): ObjectSpan | undefined {
  return objectOnLine(
    /\\\(.*?\\\)|\\\[.*?\\\]|\$\$.*?\$\$|\$(?:[^ \t\n,;.$]|[^ \t\n,;.$][^$\n]*?[^ \t\n,.$])\$(?=[\s!"#'(),.:;<>?@[\]^`{}]|$)|\\[a-zA-Z]+\*?(?:\[[^\][\n{}]*\]|\{[^{}\n]*\})+/,
    (m, line) => !(m[0].startsWith("$") && !m[0].startsWith("$$") && (m.index ?? 0) > 0 && line[(m.index ?? 0) - 1] === "$"),
  );
}

/** Whether point is on an object, not the blanks after it, as org-src--on-datum-p. */
function onObject(o: { begin: number; end: number }): boolean {
  return e8.point() >= o.begin && e8.point() <= o.end;
}

/**
 * An object's indentation, as org-src--edit-element takes it: its line's,
 * when only blanks come before it there, else the column its parent
 * element is expected at, as org--get-expected-indentation says.
 */
function objectIndentation(begin: number): number {
  const line = e8.lineOf(begin);
  if (/^[ \t]*$/.test(e8.bufferText(e8.lineStart(line), begin))) return indentationAt(begin);
  const e = elementAt(begin);
  return e ? expectedIndent(e, false, line) : indentationAt(begin);
}

/** Whether a position is in a table's cell, where a newline would break the row. */
function inTableCell(pos: number): boolean {
  return /^[ \t]*\|/.test(e8.lineText(e8.lineOf(pos)));
}

/** Edits the definition of the footnote whose reference point is on, as org-edit-footnote-reference. */
function editFootnoteReference(): void {
  const found = footnoteToEdit();
  if (!found || !onObject(found.ref)) e8.userError("Not on a footnote reference");
  const { ref, definition, inline } = found!;
  if (!ref.label) e8.userError("Cannot edit remotely anonymous footnotes");
  let d: Datum;
  let contents: string;
  const readOnly: [number, number, string, boolean, boolean][] = [];
  const blockIndentation = definition ? indentationAt(definition.postAffiliated) : objectIndentation(inline?.begin ?? ref.begin);
  e8.saveRestriction(() => {
    e8.widen();
    if (inline?.inline) {
      contents = e8.bufferSubstringNoProperties(inline.begin, inline.inline.end + 1);
      const label = /^\[fn:.*?:/.exec(contents)!;
      readOnly.push([0, [...label[0]].length, "Cannot edit footnote label", true, true]);
      const l = [...contents].length;
      readOnly.push([l - 1, l, "Cannot edit past footnote reference", false, false]);
      d = { type: "footnote-reference", beg: inline.inline.begin, end: inline.inline.end, contents, blockIndentation, preserve: false };
    } else if (definition) {
      const close = e8.bufferText(definition.postAffiliated, e8.lineEnd(e8.lineOf(definition.postAffiliated))).indexOf("]");
      const beg = definition.postAffiliated + [...e8.bufferText(definition.postAffiliated, e8.lineEnd(e8.lineOf(definition.postAffiliated))).slice(0, close + 1)].length;
      const stop = definition.contentsEnd ?? e8.lineEnd(e8.lineOf(definition.postAffiliated));
      contents = e8.bufferSubstringNoProperties(definition.postAffiliated, stop);
      const label = /^.*?\]/.exec(contents)!;
      readOnly.push([0, [...label[0]].length, "Cannot edit footnote label", true, true]);
      d = { type: "footnote-definition", beg, end: definition.contentsEnd ?? beg, contents, blockIndentation, preserve: false };
    } else e8.userError(`Cannot find definition of footnote ${ref.label}`);
  });
  const isInline = Boolean(inline?.inline);
  const inCell = isInline && inTableCell(inline!.begin);
  openAndShow(d!, `*Edit footnote [${ref.label}]*`, "org-mode", {
    remote: true,
    readOnly,
    writeBack: (text) => {
      if (!isInline) return text.slice(text.indexOf("]") + 1);
      const second = text.indexOf(":", text.indexOf(":") + 1);
      let body = text.slice(second + 1, -1);
      if (/\n[ \t]*\n/.test(body)) e8.userError("Inline definitions cannot contain blank lines");
      if (inCell) body = body.replace(/\n/g, " ");
      return body;
    },
  });
}

/** Edits the LaTeX fragment at point, its delimiters read-only, as org-edit-latex-fragment. */
function editLatexFragment(): void {
  const f = latexFragmentAt();
  if (!f || !onObject(f)) e8.userError("Not on a LaTeX fragment");
  const contents = e8.bufferSubstringNoProperties(f!.begin, f!.end);
  const delim = /^\$[^$]/.test(contents) ? 1 : 2;
  const l = [...contents].length;
  const inCell = inTableCell(f!.begin);
  const mode = langMode("latex");
  const d: Datum = { type: "latex-fragment", beg: f!.begin, end: f!.end, contents, blockIndentation: objectIndentation(f!.begin), preserve: false };
  openAndShow(d, `*Org Src ${e8.bufferName()}[ LaTeX fragment ]*`, e8.commandNames().includes(mode) ? mode : undefined, {
    keepFirstLine: true,
    readOnly: [
      [0, delim, "Cannot edit LaTeX deliminator", true, true],
      [l - delim, l, "Cannot edit LaTeX deliminator", false, false],
    ],
    writeBack: (text) => {
      // Blank lines break a fragment, and in a table a newline breaks the row.
      const t = text.replace(/\n[ \t]*\n/g, "\n");
      return inCell ? t.replace(/\n/g, " ") : t;
    },
  });
}

/** Edits inline source code in its language's mode, on one line, as org-edit-inline-src-code. */
function editInlineSrcCode(): void {
  const s = inlineSrcAt();
  if (!s || !onObject(s)) e8.userError("Not on inline source code");
  const lang = s!.match[1];
  const mode = langMode(lang);
  if (!e8.commandNames().includes(mode)) e8.signal("error", `No such language mode: ${mode}`);
  const code = s!.match[3];
  const beg = s!.end - 1 - [...code].length;
  const d: Datum = { type: "inline-src-block", beg, end: s!.end - 1, contents: code, blockIndentation: 0, preserve: true };
  openAndShow(d, `*Org Src ${e8.bufferName()}[ ${lang} ]*`, mode, (text) => text.replace(/\n[ \t]*/g, " ").replace(/^[ \t]+|[ \t]+$/g, ""));
}

e8.defineCommand({
  name: "org-edit-footnote-reference",
  doc: "Edit the definition of the footnote whose reference point is on, in a buffer of its own; C-c ' puts it back.",
  run: () => editFootnoteReference(),
});

e8.defineCommand({
  name: "org-edit-latex-fragment",
  doc: "Edit the LaTeX fragment at point in a buffer of its own, its delimiters read-only; C-c ' puts it back.",
  run: () => editLatexFragment(),
});

e8.defineCommand({
  name: "org-edit-inline-src-code",
  doc: "Edit the inline source code at point in its language's mode, on one line; C-c ' puts it back.",
  run: () => editInlineSrcCode(),
});
