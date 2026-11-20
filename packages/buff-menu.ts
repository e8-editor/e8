// The buffer list, after Emacs's buff-menu.el: C-x C-b lists the buffers
// in *Buffer List*, a tabulated list with a line each for its marks, name,
// size, mode and file, titled in the header line; there RET visits one, d
// and s mark it to be killed or saved, and x does it.

import { forwardLine } from "subr";
import { multiOccur, readOccurRegexp } from "replace";
import {
  tabulatedListGetId,
  tabulatedListGetEntry,
  tabulatedListSetCol,
  tabulatedListDeleteEntry,
  tabulatedListPrintEntry,
  tabulatedListInitHeader,
  tabulatedListPrint,
  type Entry,
} from "tabulated-list";

e8.defineVariable({ name: "Buffer-menu-use-header-line", doc: "Whether the buffer list's column titles show in the header line, rather than as its first line.", value: true });
e8.defineVariable({ name: "Buffer-menu-name-width", doc: "The width of the buffer list's name column, or a function of the buffers listed that gives it.", value: "Buffer-menu--dynamic-name-width" });
e8.defineVariable({ name: "Buffer-menu-size-width", doc: "The width of the buffer list's size column.", value: 7 });
e8.defineVariable({ name: "Buffer-menu-mode-width", doc: "The width of the buffer list's mode column.", value: 16 });
e8.defineVariable({ name: "Buffer-menu-files-only", doc: "Whether the buffer list shows only buffers visiting files.", value: false, local: true });
e8.defineVariable({ name: "Buffer-menu-show-internal", doc: "Whether the buffer list shows internal buffers, whose names start with a space.", value: false, local: true });
e8.defineVariable({ name: "Buffer-menu-marker-char", doc: "The mark m puts on a buffer to be shown by v.", value: ">" });
e8.defineVariable({ name: "Buffer-menu-del-char", doc: "The mark d puts on a buffer to be killed by x.", value: "D" });
e8.defineFace({ name: "buffer-menu-buffer", doc: "The buffers' names in the buffer list.", attributes: { bold: true } });

const LIST = "*Buffer List*";

/** The name column's width: wide enough for the names, at least 19, and at most a little under a quarter of the window, as Buffer-menu--dynamic-name-width. */
e8.defun("Buffer-menu--dynamic-name-width", (buffers: e8.Value) => {
  const names = (Array.isArray(buffers) ? buffers : []).map((b) => e8.bufferName(b as e8.Buffer) ?? "");
  const window = e8.windowSize()?.width ?? 80;
  return Math.max(19, Math.min(Math.trunc(window / 4.2), Math.max(0, ...names.map((n) => n.length))));
});

/** Sorts entries by their size column, biggest first, as tabulated-list-entry-size->. */
e8.defun("tabulated-list-entry-size->", (a: e8.Value, b: e8.Value) => {
  const size = (e: e8.Value) => parseFloat(String((e as unknown as Entry)[1][4])) || 0;
  return size(a) > size(b);
});

/** The buffer of the line point is on, or undefined, or an error with `mustExist`, as Buffer-menu-buffer. */
function menuBuffer(mustExist = false): e8.Buffer | undefined {
  const b = tabulatedListGetId();
  if (b === undefined || b === null) {
    if (mustExist) e8.signal("error", "No buffer on this line");
    return undefined;
  }
  if (!e8.bufferLiveP(b)) {
    if (mustExist) e8.signal("error", "This buffer has been killed");
    return undefined;
  }
  return b as e8.Buffer;
}

/** To the first line of buffers, as Buffer-menu-beginning. */
function menuBeginning(): void {
  e8.gotoChar(e8.pointMin());
  if (e8.variable("Buffer-menu-use-header-line") !== true) forwardLine(1);
}

/** The buffers marked with m, those marks taken off with `unmark`, as Buffer-menu-marked-buffers. */
function markedBuffers(unmark = false): e8.Buffer[] {
  const found: e8.Buffer[] = [];
  e8.saveExcursion(() => {
    menuBeginning();
    while (e8.reSearchForward("^>", { noerror: true }) !== undefined) {
      const b = menuBuffer();
      if (b !== undefined && unmark) tabulatedListSetCol(0, " ", true);
      if (b !== undefined) found.push(b);
    }
  });
  return found;
}

e8.defineCommand({
  name: "Buffer-menu-multi-occur",
  doc: "Show all lines in marked buffers containing a match for a regexp.",
  run: async () => {
    const regexp = await readOccurRegexp();
    multiOccur(markedBuffers(), regexp);
  },
});

/** Gathers the entries and sets the columns, as list-buffers--refresh. */
function refresh(oldBuffer?: e8.Buffer): void {
  const marked = markedBuffers();
  const menu = e8.getBuffer(e8.bufferName())!;
  const filesOnly = e8.variable("Buffer-menu-files-only") === true;
  const showInternal = e8.variable("Buffer-menu-show-internal") === true;
  const entries: Entry[] = [];
  for (const name of e8.bufferList()) {
    const buffer = e8.getBuffer(name)!;
    const info = e8.withCurrentBuffer(name, () => ({
      file: e8.bufferFileName(),
      readOnly: e8.bufferReadOnly(),
      modified: e8.bufferModified(),
      size: e8.bufferSize(),
      mode: e8.formatModeLine(Symbol.for("mode-name")),
      directory: e8.variable("list-buffers-directory"),
    }));
    if (!showInternal && name.startsWith(" ") && info.file === undefined) continue;
    if (buffer === menu || (filesOnly && info.file === undefined)) continue;
    const file = info.file ?? (typeof info.directory === "string" ? info.directory : undefined);
    entries.push([
      buffer,
      [
        buffer === oldBuffer ? "." : marked.includes(buffer) ? ">" : " ",
        info.readOnly ? "%" : " ",
        info.modified ? "*" : " ",
        e8.propertize(name, { "font-lock-face": "buffer-menu-buffer", "mouse-face": "highlight" }),
        String(info.size),
        String(info.mode),
        file === undefined ? "" : e8.abbreviateFileName(file),
      ],
    ]);
  }
  const widthOf = e8.variable("Buffer-menu-name-width");
  const nameWidth = typeof widthOf === "number" ? widthOf : Number(e8.funcall(String(widthOf), entries.map((e) => e[0])));
  const sym = (s: string) => Symbol.for(s) as unknown as e8.Value;
  e8.setVariable("tabulated-list-format", [
    ["C", 1, true, sym(":pad-right"), 0],
    ["R", 1, true, sym(":pad-right"), 0],
    ["M", 1, true],
    ["Buffer", nameWidth, true],
    ["Size", Number(e8.variable("Buffer-menu-size-width") ?? 7), "tabulated-list-entry-size->", sym(":right-align"), true],
    ["Mode", Number(e8.variable("Buffer-menu-mode-width") ?? 16), true],
    ["File", 1, true],
  ] as unknown as e8.Value);
  e8.setVariable("tabulated-list-use-header-line", e8.variable("Buffer-menu-use-header-line") === true);
  e8.setVariable("tabulated-list-entries", entries as unknown as e8.Value);
  tabulatedListInitHeader();
}

e8.defun("list-buffers--refresh", () => refresh());

/** Makes *Buffer List* afresh and returns it, as list-buffers-noselect. */
function listBuffersNoselect(filesOnly: e8.PrefixArg): string {
  const old = e8.getBuffer(e8.bufferName());
  e8.getBufferCreate(LIST);
  e8.withCurrentBuffer(LIST, () => {
    e8.call("Buffer-menu-mode");
    e8.setVariable("Buffer-menu-files-only", filesOnly !== null && e8.prefixNumericValue(filesOnly) >= 0);
    refresh(old);
    tabulatedListPrint();
  });
  return LIST;
}

/** Says the commands, as buffer-menu--display-help, the keys as the list's keymap has them. */
function helpMessage(): void {
  const key = (command: string) => e8.whereIs(command) ?? `M-x ${command}`;
  const keys = (commands: string[]) => commands.map(key).join(", ");
  e8.message(
    `Commands: ${keys(["Buffer-menu-delete", "Buffer-menu-save", "Buffer-menu-execute", "Buffer-menu-unmark"])}; ` +
      `${keys(["Buffer-menu-this-window", "Buffer-menu-other-window", "Buffer-menu-1-window", "Buffer-menu-2-window", "Buffer-menu-mark", "Buffer-menu-select"])}; ` +
      `${keys(["Buffer-menu-not-modified", "Buffer-menu-toggle-read-only"])}; ${key("quit-window")} to quit; ${key("describe-mode")} for help`,
  );
}

e8.defineCommand({
  name: "list-buffers",
  doc:
    "Show a list of the buffers in another window: each one's name, size, mode and file, " +
    "with . for the current one, % if read-only and * if modified. With a prefix argument, only those visiting files.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => e8.call("display-buffer", listBuffersNoselect(arg)),
});
e8.bindKey("C-x C-b", "list-buffers");

e8.defineCommand({
  name: "buffer-menu",
  doc: "Show the list of buffers in this window, to choose one or mark them to save or kill. With a prefix argument, only those visiting files.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    e8.call("switch-to-buffer", listBuffersNoselect(arg));
    helpMessage();
  },
});

e8.defineCommand({
  name: "buffer-menu-other-window",
  doc: "Show the list of buffers in another window and select it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    e8.call("switch-to-buffer-other-window", listBuffersNoselect(arg));
    helpMessage();
  },
});

const markChar = (name: "Buffer-menu-marker-char" | "Buffer-menu-del-char") => String(e8.variable(name) ?? (name === "Buffer-menu-del-char" ? "D" : ">"));

/** Takes the marks off this line, as Buffer-menu--unmark. */
function unmarkLine(): void {
  tabulatedListSetCol(0, " ", true);
  const b = menuBuffer();
  if (b !== undefined) tabulatedListSetCol(2, e8.withCurrentBuffer(b, () => e8.bufferModified()) ? "*" : " ", true);
}

const command = (name: string, doc: string, run: (...args: any[]) => void, params?: e8.Param[]) =>
  e8.defineCommand({ name, doc, ...(params ? { params } : {}), run });

command("Buffer-menu-mark", "Mark this line's buffer to be shown by v, and move down.", () => {
  if (tabulatedListGetId() !== undefined) tabulatedListSetCol(0, markChar("Buffer-menu-marker-char"), true);
  forwardLine(1);
});
command("Buffer-menu-unmark", "Take the marks off this line's buffer, and move down; with a prefix argument, up.", (backup: e8.PrefixArg) => {
  if (tabulatedListGetId() !== undefined) unmarkLine();
  forwardLine(backup === null ? 1 : -1);
}, [{ name: "backup", kind: "prefix" }]);
command("Buffer-menu-backup-unmark", "Move up and take the marks off that line's buffer.", () => {
  forwardLine(-1);
  while (tabulatedListGetId() === undefined && e8.point() > e8.pointMin()) forwardLine(-1);
  if (e8.point() > e8.pointMin() || tabulatedListGetId() !== undefined) unmarkLine();
});

/** Takes one mark, or with RET all of them, off every line, as Buffer-menu-unmark-all-buffers. */
function unmarkAllBuffers(mark: string): void {
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    while (e8.point() < e8.pointMax()) {
      const entry = tabulatedListGetEntry();
      if (entry !== undefined && (mark === "\r" || [String(entry[0]), String(entry[2])].includes(mark))) unmarkLine();
      forwardLine(1);
    }
  });
}
command("Buffer-menu-unmark-all-buffers", "Take one kind of mark off every buffer: the one typed, or with RET all of them.", async () => {
  unmarkAllBuffers(await e8.readChar("Remove marks (RET means all):"));
});
command("Buffer-menu-unmark-all", "Take the marks off every buffer.", () => unmarkAllBuffers("\r"));

/** Marks `n` lines' buffers to be killed, back when negative, as Buffer-menu-delete. */
function markDelete(n: number): void {
  if (n === 0) n = 1;
  for (; n > 0; n--) {
    if (menuBuffer() !== undefined) tabulatedListSetCol(0, markChar("Buffer-menu-del-char"), true);
    forwardLine(1);
  }
  for (; n < 0; n++) {
    if (menuBuffer() !== undefined) tabulatedListSetCol(0, markChar("Buffer-menu-del-char"), true);
    forwardLine(-1);
  }
}
command("Buffer-menu-delete", "Mark this line's buffer to be killed by x, and move down; with a prefix argument, that many lines, back if negative.", (n: number) => markDelete(n), [
  { name: "n", kind: "count" },
]);
command("Buffer-menu-delete-backwards", "Mark this line's buffer to be killed by x, and move up; with a prefix argument, that many lines.", (n: number) => markDelete(-n), [
  { name: "n", kind: "count" },
]);
command("Buffer-menu-save", "Mark this line's buffer to be saved by x, and move down.", () => {
  if (menuBuffer() !== undefined) tabulatedListSetCol(2, "S", true);
  forwardLine(1);
});
command("Buffer-menu-not-modified", "Mark this line's buffer as not modified, or with a prefix argument as modified.", (arg: e8.PrefixArg) => {
  e8.withCurrentBuffer(menuBuffer(true)!, () => e8.setBufferModified(arg !== null));
  tabulatedListSetCol(2, arg !== null ? "*" : " ", true);
}, [{ name: "arg", kind: "prefix" }]);

command("Buffer-menu-execute", "Save the buffers marked S and kill those marked D.", () => {
  e8.saveExcursion(() => {
    menuBeginning();
    while (e8.point() < e8.pointMax()) {
      const buffer = tabulatedListGetId();
      const entry = tabulatedListGetEntry();
      if (entry === undefined) {
        forwardLine(1);
        continue;
      }
      if (!e8.bufferLiveP(buffer)) {
        tabulatedListDeleteEntry();
        continue;
      }
      const kill = e8.charAfter() === "D";
      if (String(entry[2]) === "S") {
        e8.conditionCase(
          () => {
            e8.withCurrentBuffer(buffer as e8.Buffer, () => e8.call("save-buffer"));
            tabulatedListSetCol(2, " ", true);
          },
          { error: () => e8.message(`Error saving ${e8.bufferName(buffer as e8.Buffer)}`) },
        );
      }
      if (kill && buffer !== e8.getBuffer(e8.bufferName())) e8.call("kill-buffer", e8.bufferName(buffer as e8.Buffer)!);
      if (kill && !e8.bufferLiveP(buffer)) tabulatedListDeleteEntry();
      else forwardLine(1);
    }
  });
});

command("Buffer-menu-select", "Show this line's buffer as the only window, and those marked with m in windows below it.", () => {
  const self = menuBuffer(true)!;
  const menu = e8.bufferName();
  const others = markedBuffers(true).filter((b) => b !== self);
  e8.call("delete-other-windows");
  e8.call("switch-to-buffer", e8.bufferName(self)!);
  if (menu !== e8.bufferName(self)) e8.withCurrentBuffer(menu, () => e8.call("bury-buffer"));
  for (const b of others) {
    e8.call("split-window-below");
    e8.call("other-window");
    e8.call("switch-to-buffer", e8.bufferName(b)!);
  }
  e8.call("other-window");
});

command("Buffer-menu-this-window", "Show this line's buffer in this window.", () => e8.call("switch-to-buffer", e8.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-other-window", "Show this line's buffer in another window, and select it.", () => e8.call("switch-to-buffer-other-window", e8.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-switch-other-window", "Show this line's buffer in another window, staying in the list.", () => e8.call("display-buffer", e8.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-1-window", "Show this line's buffer as the only window.", () => {
  e8.call("switch-to-buffer", e8.bufferName(menuBuffer(true)!)!);
  e8.call("delete-other-windows");
});
command("Buffer-menu-2-window", "Show this line's buffer, and the one shown before it in another window.", () => {
  const b = e8.bufferName(menuBuffer(true)!)!;
  const menu = e8.bufferName();
  e8.call("delete-other-windows");
  // The buffer shown before, as other-buffer gives it.
  const other = e8.bufferList().find((n) => n !== menu && n !== b && !n.startsWith(" ")) ?? b;
  e8.call("switch-to-buffer", other);
  e8.call("switch-to-buffer-other-window", b);
  e8.withCurrentBuffer(menu, () => e8.call("bury-buffer"));
});
command("Buffer-menu-view", "View this line's buffer in view mode.", () => e8.call("view-buffer", e8.bufferName(menuBuffer(true)!)!));
command("Buffer-menu-view-other-window", "View this line's buffer in view mode, in another window.", () => {
  e8.call("switch-to-buffer-other-window", e8.bufferName(menuBuffer(true)!)!);
  if (e8.variable("view-mode") !== true) e8.call("view-mode");
});
command("Buffer-menu-toggle-read-only", "Make this line's buffer read-only, or editable again, as C-x C-q there.", () => {
  const readOnly = e8.withCurrentBuffer(menuBuffer(true)!, () => {
    e8.call("read-only-mode");
    return e8.bufferReadOnly();
  });
  tabulatedListSetCol(1, readOnly ? "%" : " ", true);
});
command("Buffer-menu-bury", "Put this line's buffer at the end of the buffer list, and its line at the end of this one.", () => {
  const b = tabulatedListGetId();
  if (b === undefined || b === null) return;
  if (e8.bufferLiveP(b)) {
    e8.withCurrentBuffer(b as e8.Buffer, () => e8.call("bury-buffer"));
    e8.saveExcursion(() => {
      const elt = tabulatedListDeleteEntry();
      e8.gotoChar(e8.pointMax());
      if (elt !== undefined) tabulatedListPrintEntry(elt[0], elt[1]);
    });
    e8.message("Buffer buried.");
  } else {
    tabulatedListDeleteEntry();
    e8.message("Buffer is dead; removing from list.");
  }
});

const selectionMessage = () =>
  e8.message(
    e8.variable("Buffer-menu-files-only") === true
      ? "Showing only file-visiting buffers."
      : e8.variable("Buffer-menu-show-internal") === true
        ? "Showing all buffers."
        : "Showing all buffers except internal ones.",
  );

for (const [name, variable, what] of [
  ["Buffer-menu-toggle-files-only", "Buffer-menu-files-only", "only buffers visiting files"],
  ["Buffer-menu-toggle-internal", "Buffer-menu-show-internal", "internal buffers too"],
] as const) {
  command(name, `Show ${what}, or not; a positive prefix argument shows them and zero or negative does not.`, (arg: e8.PrefixArg) => {
    e8.setVariable(variable, arg === null ? e8.variable(variable) !== true : e8.prefixNumericValue(arg) > 0);
    selectionMessage();
    e8.call("revert-buffer");
  }, [{ name: "arg", kind: "prefix" }]);
}

e8.defineMajorMode({
  name: "Buffer-menu-mode",
  modeName: "Buffer Menu",
  parent: "tabulated-list-mode",
  doc:
    "The mode of *Buffer List*: a line for each buffer. RET or f shows a line's buffer here, o in another window; " +
    "d marks it to be killed and s to be saved, u unmarks, and x does what is marked. g lists them again, q quits.",
  bindings: {
    v: "Buffer-menu-select",
    "2": "Buffer-menu-2-window",
    "1": "Buffer-menu-1-window",
    f: "Buffer-menu-this-window",
    e: "Buffer-menu-this-window",
    RET: "Buffer-menu-this-window",
    o: "Buffer-menu-other-window",
    "C-o": "Buffer-menu-switch-other-window",
    s: "Buffer-menu-save",
    d: "Buffer-menu-delete",
    k: "Buffer-menu-delete",
    "C-k": "Buffer-menu-delete",
    "C-d": "Buffer-menu-delete-backwards",
    x: "Buffer-menu-execute",
    SPC: "next-line",
    DEL: "Buffer-menu-backup-unmark",
    "~": "Buffer-menu-not-modified",
    u: "Buffer-menu-unmark",
    "M-DEL": "Buffer-menu-unmark-all-buffers",
    U: "Buffer-menu-unmark-all",
    m: "Buffer-menu-mark",
    "%": "Buffer-menu-toggle-read-only",
    "M-s a C-o": "Buffer-menu-multi-occur",
    b: "Buffer-menu-bury",
    V: "Buffer-menu-view",
    O: "Buffer-menu-view-other-window",
    T: "Buffer-menu-toggle-files-only",
    I: "Buffer-menu-toggle-internal",
  } as Record<string, e8.CommandName>,
  setup: () => {
    e8.addHook("tabulated-list-revert-hook", () => refresh(), { local: true });
    // Always worth reverting, and quick, as Buffer-menu-mode tells Auto-Revert.
    e8.makeLocalVariable("buffer-stale-function");
    e8.setVariable("buffer-stale-function", e8.defun("Buffer-menu--stale", () => "fast"));
  },
});
