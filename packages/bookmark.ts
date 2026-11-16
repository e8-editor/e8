// Bookmarks, after Emacs's bookmark.el: C-x r m names the place in a file,
// C-x r b goes back to it, even after the file changed around it, and
// C-x r l lists them. They are saved in Emacs's own format, in the file
// bookmark-default-file names, so Emacs and E8 share them.

import { PerBuffer } from "subr";

e8.defineVariable({ name: "bookmark-search-size", doc: "How many characters of text on each side a bookmark keeps, to find its place again after edits.", value: 16 });
e8.defineVariable({ name: "bookmark-save-flag", doc: "When bookmarks are saved: t on quitting, a number after that many changes, nil never.", value: 1 });
e8.defineVariable({ name: "bookmark-default-file", doc: "The file bookmarks are saved in, or nil for bookmarks under user-emacs-directory.", value: null });

/** A bookmark: its name and where it is, as bookmark.el's records hold them. */
interface Bookmark {
  name: string;
  filename?: string;
  front?: string;
  rear?: string;
  position: number;
}

/** The bookmarks, newest first, as bookmark-alist; undefined until the file is read. */
let alist: Bookmark[] | undefined;
let changes = 0;
/** The bookmark used last in each buffer, as bookmark-current-bookmark. */
const current = new PerBuffer<string>();

function bookmarkFile(): string | undefined {
  const own = e8.variable("bookmark-default-file");
  if (typeof own === "string") return e8.expandFileName(own);
  const dir = e8.variable("user-emacs-directory");
  return typeof dir === "string" ? e8.expandFileName("bookmarks", dir) : undefined;
}

// --- Emacs's bookmark file: a Lisp list, read and written ---------------------

type Sexp = string | number | { symbol: string } | Sexp[] | { car: Sexp; cdr: Sexp };

/** Reads the Lisp data a bookmark file holds: lists, dotted pairs, strings, numbers and symbols. */
function readSexp(text: string): Sexp | undefined {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] === ";") while (i < text.length && text[i] !== "\n") i++;
      else return;
    }
  };
  const read = (): Sexp => {
    skip();
    const c = text[i];
    if (c === "(") {
      i++;
      const items: Sexp[] = [];
      for (;;) {
        skip();
        if (text[i] === ")") {
          i++;
          return items;
        }
        if (text[i] === "." && /[\s(]/.test(text[i + 1] ?? "")) {
          i++;
          const cdr = read();
          skip();
          if (text[i] === ")") i++;
          return items.length === 1 ? { car: items[0]!, cdr } : [...items.slice(0, -1), { car: items.at(-1)!, cdr }];
        }
        if (i >= text.length) return items;
        items.push(read());
      }
    }
    if (c === '"') {
      i++;
      let s = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++;
          const e = text[i];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "\n" ? "" : (e ?? "");
        } else {
          s += text[i];
        }
        i++;
      }
      i++;
      return s;
    }
    let atom = "";
    while (i < text.length && !/[\s()";]/.test(text[i]!)) atom += text[i++];
    return /^-?\d+(\.\d+)?$/.test(atom) ? Number(atom) : { symbol: atom };
  };
  skip();
  return i < text.length ? read() : undefined;
}

/** A Lisp string, as prin1 writes one. */
const lispString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The bookmark file's text, as bookmark-write-file writes it. */
function writeText(list: Bookmark[]): string {
  const entry = (b: Bookmark) => {
    const fields = [
      b.filename !== undefined ? ` (filename . ${lispString(b.filename)})` : undefined,
      ` (front-context-string${b.front === undefined ? " . nil" : ` . ${lispString(b.front)}`})`,
      ` (rear-context-string${b.rear === undefined ? " . nil" : ` . ${lispString(b.rear)}`})`,
      ` (position . ${b.position + 1})`,
    ].filter((f) => f !== undefined);
    return `(${lispString(b.name)}\n${fields.join("\n")})`;
  };
  return `;;;; Emacs Bookmark Format Version 1;;;; -*- coding: utf-8-emacs; mode: lisp-data -*-\n;;; This format is meant to be slightly human-readable;\n;;; nevertheless, you probably don't want to edit it.\n;;; -*- End Of Bookmark File Format Version Stamp -*-\n(${list.map(entry).join("\n")}\n)\n`;
}

/** The bookmarks in a file's text. */
function parse(text: string): Bookmark[] {
  const data = readSexp(text.replace(/^;;;;.*$/gm, ""));
  if (!Array.isArray(data)) return [];
  const out: Bookmark[] = [];
  for (const item of data) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    const b: Bookmark = { name: item[0], position: 0 };
    for (const field of item.slice(1)) {
      if (Array.isArray(field) || typeof field !== "object" || !("car" in field)) continue;
      const key = typeof field.car === "object" && "symbol" in field.car ? field.car.symbol : undefined;
      const value = field.cdr;
      if (key === "filename" && typeof value === "string") b.filename = value;
      else if (key === "front-context-string" && typeof value === "string") b.front = value;
      else if (key === "rear-context-string" && typeof value === "string") b.rear = value;
      else if (key === "position" && typeof value === "number") b.position = value - 1;
    }
    out.push(b);
  }
  return out;
}

/** The bookmarks, read from the file the first time, as bookmark-maybe-load-default-file. */
function bookmarks(): Bookmark[] {
  if (alist !== undefined) return alist;
  const file = bookmarkFile();
  alist = file !== undefined && e8.fileReadableP(file) ? parse(e8.readTextFile(file) ?? "") : [];
  return alist;
}

/** Saves the bookmarks to their file, as bookmark-save does. */
function save(): void {
  const file = bookmarkFile();
  if (file === undefined) return;
  e8.writeTextFile(file, writeText(bookmarks()));
  changes = 0;
  e8.message(`Saving bookmarks to file ${file}...done`);
}

/** Notes a change, saving when bookmark-save-flag says, as bookmark-time-to-save-p. */
function changed(): void {
  changes++;
  const flag = e8.variable("bookmark-save-flag");
  if (typeof flag === "number" && changes >= flag) save();
}

e8.addHook("kill-emacs-hook", () => {
  if (changes > 0 && e8.variable("bookmark-save-flag") === true) save();
});

/** A bookmark by name, or an error, as bookmark-get-bookmark. */
function find(name: string): Bookmark {
  const b = bookmarks().find((x) => x.name === name);
  if (b === undefined) e8.userError(`Invalid bookmark ${name}`);
  return b!;
}

/** Reads a bookmark's name with completion, as bookmark-completing-read. */
async function readBookmark(prompt: string): Promise<string> {
  const names = bookmarks().map((b) => b.name);
  if (names.length === 0) e8.userError("No bookmarks exist");
  // The buffer's current bookmark is the default, or there is none, and
  // empty input is the empty name, as bookmark-completing-read has it.
  const def = current.get(e8.bufferName());
  const answer = await e8.completingRead(def === undefined ? `${prompt}: ` : `${prompt} (default ${def}): `, names, {
    requireMatch: true,
    history: "bookmark-history",
    ...(def === undefined ? {} : { default: def }),
  });
  return answer === "" ? (def ?? "") : answer;
}

e8.defineVariable({ name: "bookmark-history", doc: "Bookmark names answered at prompts, newest first.", value: [] });

e8.defineCommand({
  name: "bookmark-set",
  doc:
    "Name the place point is at in this file, to go back to with C-x r b. The default name is the file's.\n\n" +
    "A bookmark of the same name is replaced; with a prefix argument, the new one goes in front of it instead.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: e8.PrefixArg) => {
    const file = e8.bufferFileName();
    const def = current.get(e8.bufferName()) ?? (file !== undefined ? file.replace(/.*\//, "") : e8.bufferName());
    const answer = await e8.readString(`Set bookmark (default ${def}): `, { history: "bookmark-history" });
    const name = answer === "" ? def : answer;
    const size = Number(e8.variable("bookmark-search-size") ?? 16);
    const p = e8.point();
    const b: Bookmark = {
      name,
      filename: file === undefined ? undefined : e8.abbreviateFileName(file),
      front: e8.pointMax() - p >= size ? e8.bufferSubstringNoProperties(p, p + size) : undefined,
      rear: p - e8.pointMin() >= size ? e8.bufferSubstringNoProperties(p - size, p) : undefined,
      position: p,
    };
    const list = bookmarks();
    if (arg === null) {
      const i = list.findIndex((x) => x.name === name);
      if (i >= 0) list.splice(i, 1);
    }
    list.unshift(b);
    current.set(e8.bufferName(), name);
    changed();
  },
});

/** Goes to a bookmark's place: its file, at its context or else its position, as bookmark-default-handler. */
export function jumpTo(name: string, how: "switch-to-buffer" | "switch-to-buffer-other-window"): void {
  const b = find(name);
  if (b.filename === undefined || !e8.fileReadableP(e8.expandFileName(b.filename))) {
    e8.signal("bookmark-error-no-filename", `Bookmark ${name} has no file it can read`, [b.filename ?? null]);
  }
  const buffer = e8.findFileNoselect(e8.expandFileName(b.filename!));
  e8.call(how, buffer);
  e8.gotoChar(Math.min(b.position, e8.pointMax()));
  // Its text first, then the text before it, so a change around it is followed.
  if (b.front !== undefined) {
    const m = e8.search(b.front, { bound: e8.pointMax(), caseFold: false });
    if (m !== undefined) e8.gotoChar(m.start);
  }
  if (b.rear !== undefined) {
    const m = e8.search(b.rear, { backward: true, bound: e8.pointMin(), caseFold: false });
    if (m !== undefined) e8.gotoChar(m.end);
  }
  current.set(e8.bufferName(), name);
}

e8.defineCommand({
  name: "bookmark-jump",
  doc: "Go to a bookmark's place, in its file.",
  run: async () => jumpTo(await readBookmark("Jump to bookmark"), "switch-to-buffer"),
});

e8.defineCommand({
  name: "bookmark-jump-other-window",
  doc: "Go to a bookmark's place, in its file, in another window.",
  run: async () => jumpTo(await readBookmark("Jump to bookmark (in another window)"), "switch-to-buffer-other-window"),
});

e8.defineCommand({
  name: "bookmark-delete",
  doc: "Forget a bookmark.",
  run: async () => {
    const name = await readBookmark("Delete bookmark");
    const list = bookmarks();
    // A name no bookmark has deletes nothing, as Emacs's delq of nil.
    const i = list.findIndex((b) => b.name === name);
    if (i >= 0) list.splice(i, 1);
    // No buffer's current bookmark is the one gone, as bookmark-delete clears it.
    current.replaceValue(name, undefined);
    changed();
  },
});

e8.defineCommand({
  name: "bookmark-rename",
  doc: "Give a bookmark another name.",
  run: async () => {
    const old = await readBookmark("Old bookmark name");
    const name = await e8.readString(`Rename "${old}" to: `, { history: "bookmark-history" });
    find(old).name = name;
    current.replaceValue(old, name);
    changed();
  },
});

e8.defineCommand({ name: "bookmark-save", doc: "Save the bookmarks to their file.", run: () => save() });

e8.defineCommand({
  name: "bookmark-insert",
  doc: "Insert the text of the file a bookmark is in, leaving the mark after it.",
  run: async () => {
    const b = find(await readBookmark("Insert bookmark contents"));
    if (b.filename === undefined) e8.userError("That bookmark has no file");
    const text = e8.readTextFile(e8.expandFileName(b.filename!)) ?? "";
    const p = e8.point();
    e8.insert(text);
    e8.pushMark(e8.point());
    e8.gotoChar(p);
  },
});

// The bookmark list, C-x r l, after bookmark-bmenu-list.

const BMENU = "*Bookmark List*";
const deletions = new Set<string>();

function bmenuRefresh(): void {
  e8.withCurrentBuffer(BMENU, () => {
    const line = e8.lineOf(e8.point());
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      e8.insert(e8.propertize(`  ${"Bookmark Name".padEnd(30)} File`, { face: "bold" }) + "\n");
      for (const b of [...bookmarks()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
        const start = e8.point();
        e8.insert(`${deletions.has(b.name) ? "D" : " "} ${b.name.padEnd(30)} ${b.filename ?? ""}`.trimEnd());
        e8.putTextProperty(start, e8.point(), "bookmark-name-prop", b.name);
        e8.insert("\n");
      }
    });
    e8.gotoChar(e8.lineStart(Math.min(Math.max(1, line), Math.max(1, e8.lineCount() - 2))));
    e8.setBufferModified(false);
  });
}

function bmenuBookmark(): string {
  const name = e8.getTextProperty(e8.lineBeginningPosition(), "bookmark-name-prop");
  if (typeof name !== "string") e8.userError("No bookmark on this line");
  return name as string;
}

const bmenuNext = (n: number) => {
  const line = Math.max(1, Math.min(e8.lineCount() - 2, e8.lineOf(e8.point()) + n));
  e8.gotoChar(e8.lineStart(line));
};

e8.defineCommand({
  name: "bookmark-bmenu-list",
  doc: "List the bookmarks in *Bookmark List*: RET goes to one, d marks it to be deleted and x deletes those marked.",
  run: () => {
    e8.getBufferCreate(BMENU);
    e8.withCurrentBuffer(BMENU, () => {
      if (e8.variable("major-mode") !== "bookmark-bmenu-mode") e8.call("bookmark-bmenu-mode");
    });
    deletions.clear();
    bmenuRefresh();
    e8.call("switch-to-buffer", BMENU);
  },
});

for (const [name, doc, run] of [
  ["bookmark-bmenu-this-window", "Go to this line's bookmark in this window.", () => jumpTo(bmenuBookmark(), "switch-to-buffer")],
  ["bookmark-bmenu-other-window", "Go to this line's bookmark in another window.", () => jumpTo(bmenuBookmark(), "switch-to-buffer-other-window")],
  ["bookmark-bmenu-delete", "Mark this line's bookmark to be deleted by x, and move down.", () => {
    deletions.add(bmenuBookmark());
    bmenuRefresh();
    bmenuNext(1);
  }],
  ["bookmark-bmenu-unmark", "Take the mark off this line's bookmark, and move down.", () => {
    deletions.delete(bmenuBookmark());
    bmenuRefresh();
    bmenuNext(1);
  }],
  ["bookmark-bmenu-execute-deletions", "Delete the bookmarks marked with d.", () => {
    if (deletions.size === 0) return;
    alist = bookmarks().filter((b) => !deletions.has(b.name));
    deletions.clear();
    changed();
    bmenuRefresh();
  }],
  ["bookmark-bmenu-next-line", "Move to the next bookmark.", () => bmenuNext(1)],
  ["bookmark-bmenu-previous-line", "Move to the bookmark before.", () => bmenuNext(-1)],
  ["bookmark-bmenu-revert", "List the bookmarks again.", () => bmenuRefresh()],
] as const) {
  e8.defineCommand({ name, doc, run });
}

e8.defineMajorMode({
  name: "bookmark-bmenu-mode",
  modeName: "Bookmark Menu",
  doc: "The mode of *Bookmark List*: RET goes to a bookmark, o in another window, d marks it to be deleted, x deletes, g lists again, q quits.",
  bindings: {
    RET: "bookmark-bmenu-this-window",
    f: "bookmark-bmenu-this-window",
    o: "bookmark-bmenu-other-window",
    d: "bookmark-bmenu-delete",
    k: "bookmark-bmenu-delete",
    u: "bookmark-bmenu-unmark",
    x: "bookmark-bmenu-execute-deletions",
    n: "bookmark-bmenu-next-line",
    p: "bookmark-bmenu-previous-line",
    g: "bookmark-bmenu-revert",
    s: "bookmark-save",
    q: "quit-window",
  } as Record<string, e8.CommandName>,
  setup: () => {
    e8.setVariable("truncate-lines", true);
    e8.setReadOnly(true);
  },
});

for (const [keys, command] of [
  ["C-x r m", "bookmark-set"],
  ["C-x r b", "bookmark-jump"],
  ["C-x r l", "bookmark-bmenu-list"],
] as const) {
  e8.bindKey(keys, command);
}
