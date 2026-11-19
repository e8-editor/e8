// Jumping to a definition by name, after Emacs's imenu.el: M-x imenu reads
// an item of the buffer's index with completion, a submenu's name opening
// its items, and goes there. A mode makes the index with
// imenu-create-index-function, or gives imenu-generic-expression, Emacs
// regexps for each kind of definition, or imenu-prev-index-position-function
// and imenu-extract-index-name-function. The index is kept, its positions
// markers, until *Rescan* is chosen, unless imenu-auto-rescan; and
// imenu-add-menubar-index puts it on the menu bar.

import { easyMenuFill, type MenuItem } from "easymenu";
import { allMatches, truthy } from "subr";

/**
 * An index item, as an element of Emacs's imenu--index-alist: a name and
 * where it is, `[name, position]`; a name and a function to go there with,
 * `[name, position, function, ...arguments]`; or a submenu, `[name, items]`.
 * A position is a number or a marker.
 */
export type IndexAlistItem = [string, number | e8.Marker | IndexAlistItem[], ...e8.Value[]];

/** An index item as makeIndex gives it, its position a number: `[name, position]` or a submenu `[name, items]`. */
export type IndexItem = [string, number | IndexItem[]];

for (const [name, doc, value, local] of [
  ["imenu-use-markers", "Whether index positions are markers, which follow edits, rather than numbers.", true, false],
  ["imenu-max-item-length", "If a number, the longest an index name is; longer ones are cut.", 60, false],
  ["imenu-auto-rescan", "Whether the index is made afresh each time, rather than kept until *Rescan* is chosen.", false, false],
  ["imenu-auto-rescan-maxout", "The size, in characters, above which a buffer's index is kept even with imenu-auto-rescan.", 600000, false],
  ["imenu-use-popup-menu", "Whether to choose from a menu rather than with completion: true always, on-mouse when imenu was run from the mouse, nil never.", "on-mouse", false],
  ["imenu-eager-completion-buffer", "Whether the completions are listed at once.", true, false],
  ["imenu-after-jump-hook", "Functions run after M-x imenu goes to an item.", null, false],
  ["imenu-sort-function", "How the menu bar's index is sorted: a function of two items, true if the first comes first, as imenu--sort-by-name; nil for the order found.", null, false],
  ["imenu-max-items", "The most items a menu of the index holds before it is split into submenus.", 25, false],
  ["imenu-space-replacement", "What spaces in index names are shown as, so a name reads as one word in completion; nil to leave them.", ".", false],
  ["imenu-level-separator", "What goes between a submenu's name and an item's when the index is flattened.", ":", false],
  ["imenu-flatten", "Whether to offer the index as one list: prefix puts each submenu's name before its items' names; nil keeps the submenus.", null, false],
  ["imenu-generic-skip-comments-and-strings", "Whether imenu-generic-expression's matches inside comments and strings are passed over.", true, false],
  ["imenu-max-index-time", "The most seconds making the index may take.", 5, false],
  ["imenu-generic-expression", "For imenu-default-create-index-function: a list of [menu-title, regexp, index, function?, ...arguments], each regexp an Emacs regexp, or a function searching backwards, whose group `index` is a definition's name; a null title puts the items at the top.", null, true],
  ["imenu-create-index-function", "The function that makes the buffer's index, called with no arguments, as imenu--index-alist holds it.", "imenu-default-create-index-function", true],
  ["imenu-submenus-on-top", "Whether submenus come before items in the menu bar's index.", true, true],
  ["imenu-prev-index-position-function", "For imenu-default-create-index-function: a function moving point back to the previous definition, nil if there is none.", "beginning-of-defun", true],
  ["imenu-extract-index-name-function", "For imenu-default-create-index-function: a function giving the name of the definition at point.", null, true],
  ["imenu-name-lookup-function", "A function of two strings saying whether a name matches an index item's; nil for equality.", null, true],
  ["imenu-default-goto-function", "The function that goes to an item, called with its name and position.", "imenu-default-goto-function", true],
  ["imenu-case-fold-search", "Whether imenu-generic-expression's regexps match case loosely.", true, true],
  ["imenu-syntax-alist", "Syntax to give characters while imenu-generic-expression's regexps match: [character or string, syntax descriptor] pairs.", null, true],
  ["imenu--index-alist", "The index made for this buffer, kept until rescanned.", null, true],
  ["imenu--history-list", "Items chosen with M-x imenu, newest first.", [], false],
  ["imenu-menubar-modified-tick", "The buffer's characters-modified tick when the menu bar's index was last made.", 0, true],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value, local });
}

e8.defineError("imenu-unavailable", "error");
const v = (name: string): e8.Value | undefined => e8.variable(name);

/** Signals imenu-unavailable, as imenu-unavailable-error. */
function unavailable(message: string): never {
  e8.signal("imenu-unavailable", message, [message]);
}

/** The item that makes the index again, as imenu--rescan-item. */
const RESCAN: IndexAlistItem = ["*Rescan*", -99];
const isRescan = (item: IndexAlistItem): boolean => item[0] === "*Rescan*" && item[1] === -99;

/** Whether an item is a submenu, as imenu--subalist-p. */
export const isSubmenu = (item: IndexAlistItem): item is [string, IndexAlistItem[]] => Array.isArray(item[1]);

/** Where an item is, as a number. */
export const position = (pos: number | e8.Marker | IndexAlistItem[] | e8.Value): number => (typeof pos === "number" ? pos : e8.markerPosition(pos as e8.Marker) ?? 0);

/** Items in name order, as imenu--sort-by-name. */
export const sortByName = (a: IndexAlistItem, b: IndexAlistItem): boolean => a[0] < b[0];
e8.defun("imenu--sort-by-name", (a: IndexAlistItem, b: IndexAlistItem) => sortByName(a, b));
/** Items in buffer order, as imenu--sort-by-position. */
export const sortByPosition = (a: IndexAlistItem, b: IndexAlistItem): boolean => position(a[1]) < position(b[1]);
e8.defun("imenu--sort-by-position", (a: IndexAlistItem, b: IndexAlistItem) => sortByPosition(a, b));

/** A list in pieces of at most `n`, as imenu--split. */
function split<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * A menu of items under `title`, as imenu--split-menu: *Rescan* first,
 * then submenus if imenu-submenus-on-top, the rest sorted by
 * imenu-sort-function and split into "From: NAME" submenus beyond
 * imenu-max-items.
 */
function splitMenu(items: IndexAlistItem[], title: string): [string, IndexAlistItem[]] {
  let menu = [...items];
  const top: IndexAlistItem[] = [];
  const rescan = menu.find(isRescan);
  if (rescan) {
    top.push(rescan);
    menu = menu.filter((i) => i !== rescan);
  }
  if (truthy(v("imenu-submenus-on-top"))) {
    top.push(...menu.filter(isSubmenu));
    menu = menu.filter((i) => !isSubmenu(i));
  }
  const sort = v("imenu-sort-function");
  if (truthy(sort)) menu.sort((a, b) => (truthy(e8.funcall(sort as string, a as unknown as e8.Value, b as unknown as e8.Value)) ? -1 : truthy(e8.funcall(sort as string, b as unknown as e8.Value, a as unknown as e8.Value)) ? 1 : 0));
  const max = Number(v("imenu-max-items")) || 25;
  const rest: IndexAlistItem[] = menu.length > max ? split(menu, max).map((part) => [`From: ${part[0]![0]}`, part] as IndexAlistItem) : menu;
  return [title, [...top, ...rest]];
}

/** Each submenu split as splitMenu does, as imenu--split-submenus. */
const splitSubmenus = (items: IndexAlistItem[]): IndexAlistItem[] => items.map((item) => (isSubmenu(item) ? splitMenu(item[1], item[0]) : item));

/** Names longer than imenu-max-item-length cut to it, as imenu--truncate-items. */
function truncateItems(items: IndexAlistItem[]): void {
  const max = v("imenu-max-item-length");
  for (const item of items) {
    if (typeof max === "number" && item[0].length > max) item[0] = item[0].slice(0, max);
    if (isSubmenu(item)) truncateItems(item[1]);
  }
}

/** Markers made for the index pointing nowhere, as imenu--cleanup. */
function cleanup(items: IndexAlistItem[] | null | undefined = v("imenu--index-alist") as IndexAlistItem[] | null): void {
  for (const item of items ?? []) {
    if (isSubmenu(item)) cleanup(item[1]);
    else if (item[1] instanceof e8.Marker) e8.setMarker(item[1], null);
  }
}

/** Forgets the index, so it is made afresh next time, as imenu-flush-cache. */
export function flushCache(): void {
  cleanup();
  e8.setVariable("imenu--index-alist", null);
}
e8.defun("imenu-flush-cache", flushCache);

/**
 * The buffer's index, as imenu--make-index-alist: the one kept, unless
 * imenu-auto-rescan and the buffer is no larger than
 * imenu-auto-rescan-maxout, else made by imenu-create-index-function over
 * the whole buffer, names cut to imenu-max-item-length; *Rescan* first
 * unless imenu-auto-rescan. An empty index is an error unless `noerror`.
 */
export function makeIndexAlist(noerror = false): IndexAlistItem[] {
  let index = v("imenu--index-alist") as IndexAlistItem[] | null;
  const auto = truthy(v("imenu-auto-rescan"));
  // An empty index is nil, as in Emacs, and made again next time.
  const keep = Array.isArray(index) && index.length > 0 && (!auto || e8.bufferSize() > (Number(v("imenu-auto-rescan-maxout")) || 600000));
  if (!keep) {
    index = createIndex();
    // Kept positions follow edits: a function that gave numbers, as some
    // modes' do, has them made markers, as Emacs's own give markers.
    if (index && truthy(v("imenu-use-markers"))) markPositions(index);
    if (index) truncateItems(index);
    e8.setVariable("imenu--index-alist", (index && index.length > 0 ? index : null) as unknown as e8.Value);
  }
  if ((!index || index.length === 0) && !noerror) unavailable("No items suitable for an index found in this buffer");
  const items = index ?? [];
  return auto ? items : [RESCAN, ...items];
}
e8.defun("imenu--make-index-alist", (noerror?: e8.Value) => makeIndexAlist(truthy(noerror)) as unknown as e8.Value);

/** The index as imenu-create-index-function makes it now, over the whole buffer. */
function createIndex(): IndexAlistItem[] | null {
  const fn = v("imenu-create-index-function") ?? "imenu-default-create-index-function";
  return e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      return e8.funcall(fn as string) as unknown as IndexAlistItem[] | null;
    }),
  );
}

/** Each number in an index made a marker. */
function markPositions(items: IndexAlistItem[]): void {
  for (const item of items) {
    if (isSubmenu(item)) markPositions(item[1]);
    else if (typeof item[1] === "number" && item[1] >= 0) item[1] = e8.makeMarker(item[1]);
  }
}

/**
 * The index made afresh, its positions numbers, without *Rescan*, for
 * packages that list it, as consult-imenu calls imenu-create-index-function
 * itself rather than take the kept one. An empty index is an error.
 */
export function makeIndex(): IndexItem[] {
  const numbers = (items: IndexAlistItem[]): IndexItem[] =>
    items.map((item) => (isSubmenu(item) ? [item[0], numbers(item[1])] : [item[0], position(item[1]), ...item.slice(2)]) as IndexItem);
  const index = createIndex();
  if (!index || index.length === 0) unavailable("No items suitable for an index found in this buffer");
  truncateItems(index);
  return numbers(index);
}

/** The item a name stands for, at any depth, as imenu--in-alist. */
function inAlist(name: string, items: IndexAlistItem[]): IndexAlistItem | undefined {
  const lookup = v("imenu-name-lookup-function");
  for (const item of items) {
    if (isSubmenu(item)) {
      const found = inAlist(name, item[1]);
      if (found) return found;
    } else if (truthy(lookup) ? truthy(e8.funcall(lookup as string, name, item[0])) : name === item[0]) {
      return item;
    }
  }
  return undefined;
}

/**
 * The index from imenu-prev-index-position-function and
 * imenu-extract-index-name-function, or else from imenu-generic-expression,
 * as imenu-default-create-index-function.
 */
function defaultCreateIndex(): IndexAlistItem[] {
  const prev = v("imenu-prev-index-position-function");
  const extract = v("imenu-extract-index-name-function");
  if (truthy(prev) && truthy(extract)) {
    const index: IndexAlistItem[] = [];
    let pos = e8.pointMax();
    const start = Date.now();
    const limit = (Number(v("imenu-max-index-time")) || 5) * 1000;
    e8.gotoChar(pos);
    while (truthy(e8.funcall(prev as string)) && Date.now() - start < limit) {
      if (e8.point() >= pos) e8.signal("error", `Infinite loop at ${e8.bufferName()}:${pos}: imenu-prev-index-position-function does not move point`);
      pos = e8.point();
      const name = e8.saveExcursion(() => e8.funcall(extract as string));
      if (typeof name === "string") index.unshift([name, truthy(v("imenu-use-markers")) ? e8.makeMarker(pos) : pos]);
    }
    return index;
  }
  const patterns = v("imenu-generic-expression");
  if (Array.isArray(patterns) && patterns.length > 0) return genericIndex(patterns as unknown as GenericPattern[]);
  unavailable("This buffer cannot use `imenu-default-create-index-function'");
}
e8.defun("imenu-default-create-index-function", () => defaultCreateIndex() as unknown as e8.Value);

/** One of imenu-generic-expression's patterns: title, regexp or function, group, and an optional function and its arguments. */
type GenericPattern = [string | null, string | ((...args: unknown[]) => unknown), number, ...e8.Value[]];

/**
 * The index imenu-generic-expression gives, as imenu--generic-function:
 * each pattern's matches, searching backwards, from the start of the line
 * each name is on, under its title, those in comments and strings or
 * invisible passed over, each submenu in buffer order, untitled items at
 * the top, in no more than imenu-max-index-time seconds.
 */
export function genericIndex(patterns: GenericPattern[]): IndexAlistItem[] {
  const fold =
    e8.localVariableP("imenu-case-fold-search") || !e8.localVariableP("font-lock-defaults")
      ? truthy(v("imenu-case-fold-search"))
      : truthy((v("font-lock-defaults") as e8.Value[] | null)?.[2]);
  const skip = truthy(v("imenu-generic-skip-comments-and-strings"));
  const markers = truthy(v("imenu-use-markers"));
  const start = Date.now();
  const limit = (Number(v("imenu-max-index-time")) || 5) * 1000;
  const menus = new Map<string | null, IndexAlistItem[]>();
  const order: (string | null)[] = [];
  const syntaxAlist = (v("imenu-syntax-alist") as [number | string, string][] | null) ?? [];
  const table = syntaxAlist.length > 0 ? e8.copySyntaxTable(e8.syntaxTable()) : undefined;
  for (const [chars, syntax] of syntaxAlist) {
    for (const c of typeof chars === "number" ? [String.fromCodePoint(chars)] : [...chars]) e8.modifySyntaxEntry(c, syntax, table);
  }
  const old = e8.syntaxTable();
  if (table) e8.setSyntaxTable(table);
  try {
    (() => {
      for (const [title, regexp, group, fn, ...args] of patterns) {
        e8.gotoChar(e8.pointMax());
        for (;;) {
          let found: boolean;
          // A function searches itself, as functionp patterns do; a string is a regexp.
          if (typeof regexp === "function") {
            found = truthy(regexp() as e8.Value);
          } else {
            found = e8.reSearchBackward(regexp as string, { noerror: true, caseFold: fold }) !== undefined;
            // An invisible definition does not count: the search goes on
            // to the next, which counts whatever it is, as imenu.el's loop does.
            if (found && truthy(e8.invisibleP(e8.point()) as e8.Value)) {
              found = e8.reSearchBackward(regexp as string, { noerror: true, caseFold: fold }) !== undefined;
            }
          }
          if (!found || e8.matchBeginning(0) === e8.matchEnd(0)) break;
          if (Date.now() - start >= limit) {
            e8.message("`imenu-max-index-time' exceeded");
            break;
          }
          const here = e8.point();
          const beg = e8.lineBeginningPosition(e8.matchBeginning(group) ?? here);
          const name = e8.matchString(group) ?? "";
          if (!menus.has(title)) {
            menus.set(title, []);
            order.unshift(title);
          }
          const menu = menus.get(title)!;
          const inComment = skip && e8.saveExcursion(() => {
            e8.gotoChar(here);
            const state = e8.syntaxPpss();
            return state.inString !== null || state.inComment !== null;
          });
          const extra = fn !== undefined ? [fn, ...args] : [];
          const same = (item: IndexAlistItem) =>
            item[0] === name && position(item[1]) === beg && item.length === extra.length + 2 && extra.every((x, k) => JSON.stringify(item[k + 2]) === JSON.stringify(x));
          if (!inComment && !menu.some(same)) {
            const where = markers ? e8.makeMarker(beg) : beg;
            menu.unshift((fn !== undefined ? [name, where, fn, ...args] : [name, where]) as IndexAlistItem);
          }
          e8.gotoChar(here);
        }
      }
    })();
  } finally {
    if (table) e8.setSyntaxTable(old);
  }
  const top: IndexAlistItem[] = [];
  const subs: IndexAlistItem[] = [];
  for (const title of order) {
    const items = menus.get(title)!;
    if (items.length === 0) continue;
    items.sort((a, b) => position(a[1]) - position(b[1]));
    if (title === null) top.push(...items);
    else subs.push([title, items]);
  }
  return [...subs, ...top];
}
e8.defun("imenu--generic-function", (patterns: e8.Value) => genericIndex(patterns as unknown as GenericPattern[]) as unknown as e8.Value);

/** The index name that best matches `guess`, as imenu-find-default: itself, then whole, at the start, at the end, anywhere, case aside. */
function findDefault(guess: string, items: IndexAlistItem[]): string | undefined {
  if (items.some((i) => i[0] === guess)) return guess;
  const g = guess.toLowerCase();
  const tests = [(n: string) => n === g, (n: string) => n.startsWith(g), (n: string) => n.endsWith(g), (n: string) => n.includes(g)];
  for (const test of tests) {
    const hit = items.find((i) => test(i[0].toLowerCase()));
    if (hit) return hit[0];
  }
  return undefined;
}

/** The symbol at point, if there is one. */
function symbolAtPoint(): string | undefined {
  const line = e8.lineText(e8.lineOf(e8.point()));
  const col = e8.point() - e8.lineBeginningPosition();
  for (const m of allMatches(/[\w$-]+/g, line)) {
    if (m.index! <= col && col <= m.index! + m[0].length) return m[0];
  }
  return undefined;
}

/** A name with its spaces shown as imenu-space-replacement. */
function shown(name: string): string {
  const r = v("imenu-space-replacement");
  return typeof r === "string" && r !== "" ? name.replaceAll(" ", r[0]!) : name;
}

/**
 * Reads an item of `items` with completion, as imenu--completion-buffer:
 * a submenu's name reads one of its items in turn.
 */
async function completionBuffer(items: IndexAlistItem[], prompt?: string): Promise<IndexAlistItem | undefined> {
  const prepared = items.map((item) => [shown(item[0]), ...item.slice(1)] as IndexAlistItem);
  let name = symbolAtPoint();
  if (name !== undefined) name = findDefault(name, prepared) ?? name;
  // The prompt names it only if it is in the index; M-n offers it anyway, as format-prompt and completing-read's default do.
  const fallback = name !== undefined && inAlist(name, prepared) ? name : undefined;
  const p = prompt ?? (fallback === undefined ? "Index item: " : `Index item (default ${fallback}): `);
  const chosen = await e8.completingRead(p, prepared.map((i) => i[0]), { requireMatch: true, default: name, history: "imenu--history-list", category: "imenu" });
  const choice = prepared.find((i) => i[0] === (chosen === "" ? fallback : chosen));
  if (choice === undefined) return undefined;
  return isSubmenu(choice) ? completionBuffer(choice[1], p) : choice;
}

/**
 * The index as one list, as imenu--flatten-index-alist: with
 * `concatNames`, an item under submenus named after them, joined by
 * imenu-level-separator.
 */
export function flattenIndex(items: IndexAlistItem[], concatNames: boolean, prefix?: string): IndexAlistItem[] {
  const sep = String(v("imenu-level-separator") ?? ":");
  return items.flatMap((item) => {
    const name = concatNames ? (prefix !== undefined ? `${prefix}${sep}${item[0]}` : item[0]) : item[0];
    return isSubmenu(item) ? flattenIndex(item[1], concatNames, concatNames ? name : undefined) : [[name, ...item.slice(1)] as IndexAlistItem];
  });
}

/**
 * Has the user choose an item of the buffer's index, or of `items`, as
 * imenu-choose-buffer-index: *Rescan* makes the index afresh and asks again.
 */
export async function chooseBufferIndex(prompt?: string, items?: IndexAlistItem[]): Promise<IndexAlistItem | undefined> {
  for (;;) {
    let index = items ?? makeIndexAlist();
    if (truthy(v("imenu-flatten"))) index = flattenIndex(index, true);
    const result = await completionBuffer(index, prompt);
    if (result !== undefined && isRescan(result)) {
      flushCache();
      continue;
    }
    return result;
  }
}

/** Goes to a position, widening if it is outside the narrowing, as imenu-default-goto-function. */
e8.defun("imenu-default-goto-function", (_name: string, pos: number | e8.Marker) => {
  const at = position(pos);
  if (at < e8.pointMin() || at > e8.pointMax()) e8.widen();
  e8.gotoChar(at);
});

/**
 * Goes to an index item, as the function imenu: by its function and
 * arguments if it has one, else by imenu-default-goto-function; a name is
 * looked up in the index. The mark is pushed first, and
 * imenu-after-jump-hook runs after.
 */
export function imenu(item: IndexAlistItem | string | undefined): void {
  if (typeof item === "string") item = makeIndexAlist().find((i) => i[0] === item);
  if (item === undefined) return;
  if (isSubmenu(item)) e8.signal("error", `Unknown imenu item: ${JSON.stringify(item[0])}`);
  const [name, pos, fn, ...args] = item;
  e8.pushMark(e8.point());
  e8.funcall((fn ?? v("imenu-default-goto-function") ?? "imenu-default-goto-function") as string, name, pos as e8.Value, ...args);
  e8.runHooks("imenu-after-jump-hook");
}

e8.defineCommand({
  name: "imenu",
  doc:
    "Go to a definition in the buffer, chosen by name with completion from the buffer's index.\n\n" +
    "Kinds of definition, such as Fn or Struct, open a list of their own; *Rescan* makes the index again. " +
    "The mark is pushed first.",
  run: async () => imenu(await chooseBufferIndex()),
});

// --- The index on the menu bar ---------------------------------------------

/** The items of the menu bar's index in each buffer, by buffer id, for its commands. */
const menubarItems = new Map<number, IndexAlistItem[]>();
/** The menu bar's index's keymap in each buffer, by buffer id. */
const menubarKeymaps = new Map<number, e8.Keymap>();
/** The index each buffer's menu was last made from, as imenu--last-menubar-index-alist. */
const lastMenubarIndex = new Map<number, string>();
let menubarCommands = 0;

/** A command for the menu bar's index's item `i`, as imenu--menubar-select is for each. */
function menubarCommand(i: number): e8.CommandName {
  for (; menubarCommands <= i; menubarCommands++) {
    const n = menubarCommands;
    e8.defineCommand({
      name: `imenu--menubar-select-${n}`,
      doc: "Go to the item of the buffer's index this menu item names, as imenu--menubar-select.",
      run: () => {
        const item = menubarItems.get(e8.currentBuffer().id)?.[n];
        if (item === undefined) return;
        if (isRescan(item)) {
          flushCache();
          e8.setVariable("imenu-menubar-modified-tick", -1);
          lastMenubarIndex.delete(e8.currentBuffer().id);
          updateMenubar();
        } else imenu(item);
      },
    });
  }
  return `imenu--menubar-select-${i}` as e8.CommandName;
}

/** Menu items for index items, each going there; submenus as submenus. */
function menuItems(items: IndexAlistItem[], all: IndexAlistItem[]): MenuItem[] {
  return items.map((item) =>
    isSubmenu(item) ? { label: item[0], items: menuItems(item[1], all) } : { label: item[0], command: menubarCommand(all.push(item) - 1) },
  );
}

/** Makes the menu bar's index again if the buffer changed, as imenu-update-menubar. */
function updateMenubar(): void {
  const id = e8.currentBuffer().id;
  const keymap = menubarKeymaps.get(id);
  if (!keymap || e8.menuOrPopupActiveP()) return;
  const tick = e8.bufferCharsModifiedTick();
  if (tick === v("imenu-menubar-modified-tick")) return;
  e8.setVariable("imenu-menubar-modified-tick", tick);
  const index = makeIndexAlist(true);
  const key = JSON.stringify(index.map(function names(i: IndexAlistItem): unknown {
    return isSubmenu(i) ? [i[0], i[1].map(names)] : [i[0], position(i[1])];
  }));
  if (key === lastMenubarIndex.get(id)) return;
  lastMenubarIndex.set(id, key);
  let [, menu] = splitMenu(splitSubmenus(index), e8.bufferName());
  // A lone submenu's items are the menu's own, as imenu-update-menubar has them.
  if (menu.length === 1 && isSubmenu(menu[0]!) && menu[0]![1].length > 0) menu = menu[0]![1];
  const all: IndexAlistItem[] = [];
  const items = menuItems(menu, all);
  menubarItems.set(id, all);
  for (const old of e8.keymapMenuKeys(keymap)) e8.keymapUnset(keymap, old, true);
  easyMenuFill(keymap, items);
}

/** Whether the buffer can make an index. */
const supportsImenu = (): boolean =>
  (truthy(v("imenu-prev-index-position-function")) && truthy(v("imenu-extract-index-name-function"))) ||
  truthy(v("imenu-generic-expression")) ||
  v("imenu-create-index-function") !== "imenu-default-create-index-function";

/**
 * Puts the buffer's index on the menu bar under `name`, as
 * imenu-add-to-menubar: a keymap of the buffer's own, its parent the local
 * map, made again as the buffer changes.
 */
export function addToMenubar(name: string): void {
  if (!supportsImenu()) unavailable(`The mode \`${String(v("mode-name") ?? v("major-mode"))}' does not support Imenu`);
  const id = e8.currentBuffer().id;
  // Already there if the local map has it, as Emacs looks; a new major mode
  // gives the buffer a new local map without it.
  const local = e8.currentLocalMap();
  if (local && e8.keymapp(e8.lookupKey(local, "<menu-bar> <index>"))) return;
  const map = e8.makeSparseKeymap(local ?? null);
  const index = e8.makeSparseKeymap(null, "Imenu");
  e8.defineMenuItem(map, "<menu-bar> <index>", { label: name, binding: index });
  e8.useLocalMap(map);
  menubarKeymaps.set(id, index);
  lastMenubarIndex.delete(id);
  e8.addHook("menu-bar-update-hook", updateMenubar);
  e8.addHook("kill-buffer-hook", () => {
    menubarKeymaps.delete(id);
    menubarItems.delete(id);
    lastMenubarIndex.delete(id);
  }, { local: true });
  updateMenubar();
}

e8.defineCommand({
  name: "imenu-add-to-menubar",
  doc: "Put the buffer's index on the menu bar, named as asked.",
  params: [{ name: "name", prompt: "Imenu menu item name: " }],
  run: (name: string) => addToMenubar(name),
});

e8.defineCommand({
  name: "imenu-add-menubar-index",
  doc: "Put the buffer's index on the menu bar as Index, as a function for mode hooks.",
  run: () => addToMenubar("Index"),
});
