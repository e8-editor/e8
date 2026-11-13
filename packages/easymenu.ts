// Menus written as data, after Emacs's easymenu.el: a mode describes its
// menu as a list of items and easyMenuDefine binds it under [menu-bar] in
// the mode's keymap, where the menu bar finds it. Emacs writes an item as
// a vector, ["Open" open-file :enable t]; here it is an object, and a
// submenu is an item with items of its own.

import { truthy } from "subr";

/// What an item of a menu says.
export interface MenuItem {
  /** What it reads, or "--" for a line across the menu. */
  label: string;
  /** The command it runs. */
  command?: e8.CommandName | e8.DefinedCommand;
  /** The items of its submenu, if it opens one. */
  items?: MenuItem[];
  /** Whether it can be chosen: a value, or a function called for it. */
  enable?: e8.Value | (() => unknown);
  /** Whether it is in the menu at all. */
  visible?: e8.Value | (() => unknown);
  /** What it does, shown in the echo area. */
  help?: string;
  /** The keys shown beside it; without, the keys that run its command. */
  keys?: string;
  /** Whether it shows a button, and what says it is on. */
  style?: "toggle" | "radio";
  selected?: e8.Value | (() => unknown);
  /** Given the submenu, gives the one to show. */
  filter?: (menu: e8.Keymap) => e8.Keymap;
  /** The key it is bound to; without one, its label names it. */
  key?: string;
}

/** A line across the menu, as Emacs's "--" item is. */
export const separator: MenuItem = { label: "--" };

/** The key an item is bound to: its own, or one made from its label. */
function keyOf(item: MenuItem, taken: Set<string>): string {
  if (item.key) {
    return item.key;
  }
  const name = item.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let key = name === "" ? "item" : name;
  // Two items of one menu that read the same get keys of their own, as
  // easy-menu-avoid-duplicate-keys gives them.
  for (let n = 2; taken.has(key); n += 1) {
    key = `${name}-${n}`;
  }
  taken.add(key);
  return key;
}

/**
 * Make a keymap of a menu's items, as easy-menu-create-menu does: each
 * item bound under a key of its own, submenus as keymaps of their own.
 */
export function easyMenuCreateMenu(_name: string | null, items: MenuItem[]): e8.Keymap {
  const menu = e8.makeSparseKeymap();
  easyMenuFill(menu, items);
  return menu;
}

/**
 * Put a menu's items in a keymap that is already there, for a menu made
 * again as its items change, so that no keymap is made for each.
 */
export function easyMenuFill(menu: e8.Keymap, items: MenuItem[]): void {
  const taken = new Set<string>();
  for (const item of items) {
    const key = `<${keyOf(item, taken)}>`;
    const binding = item.items ? easyMenuCreateMenu(item.label, item.items) : (item.command ?? null);
    e8.defineMenuItem(menu, key, {
      label: item.label,
      binding,
      enable: item.enable,
      visible: item.visible,
      help: item.help,
      keys: item.keys,
      button: item.style ? [item.style, item.selected ?? null] : undefined,
      filter: item.filter,
    });
  }
}

/**
 * Define a menu and bind it on the menu bar of each keymap in `maps`, as
 * easy-menu-define does. `key` is what names it on the bar, as Emacs's
 * `[menu-bar file]` names the File menu, and what
 * `menu-bar-final-items` goes by. Gives the menu's keymap back.
 */
export function easyMenuDefine(key: string, maps: (string | e8.Keymap)[], doc: string, menu: { label: string; items: MenuItem[] }): e8.Keymap {
  const made = easyMenuCreateMenu(menu.label, menu.items);
  for (const map of maps) {
    e8.defineMenuItem(map, `<menu-bar> <${key}>`, { label: menu.label, binding: made, help: doc });
  }
  return made;
}

/**
 * The keymap a path of menu names leads to: a keymap that binds
 * `<menu-bar>`, as a mode map or the global map does, is looked in there,
 * as easy-menu-get-map pushes `menu-bar` onto the path. An empty path
 * gives the menu bar itself.
 */
function menuAt(map: string | e8.Keymap, path: string[]): e8.Keymap | undefined {
  const bar = e8.lookupKey(map, "<menu-bar>");
  let here: e8.Keymap = e8.keymapp(bar) ? bar : (map as e8.Keymap);
  if (typeof map === "string" && !e8.keymapp(bar)) {
    const named = e8.variable(map);
    if (!e8.keymapp(named)) {
      return undefined;
    }
    here = named;
  }
  for (const name of path) {
    const key = itemKeyNamed(here, name);
    if (key === undefined) {
      return undefined;
    }
    const next = e8.lookupKey(here, key);
    if (!e8.keymapp(next)) {
      return undefined;
    }
    here = next;
  }
  return here;
}

/** The key of the item of a menu keymap whose label is `name`. */
function itemKeyNamed(map: string | e8.Keymap, name: string): string | undefined {
  for (const key of e8.keymapMenuKeys(map)) {
    if (e8.menuItem(map, key)?.label === name) {
      return key;
    }
  }
  return undefined;
}

/**
 * Add an item to a menu under a path of menu names, as
 * easy-menu-add-item does: ["File"] puts it in the File menu.
 */
export function easyMenuAddItem(map: string | e8.Keymap, path: string[], item: MenuItem): void {
  const into = menuAt(map, path);
  if (into === undefined) {
    e8.signal("error", `No menu ${path.join("/")}`);
  }
  const taken = new Set(e8.keymapMenuKeys(into).map((k) => k.replace(/^<|>$/g, "")));
  const key = `<${keyOf(item, taken)}>`;
  const binding = item.items ? easyMenuCreateMenu(item.label, item.items) : (item.command ?? null);
  e8.defineMenuItem(into, key, {
    label: item.label,
    binding,
    enable: item.enable,
    visible: item.visible,
    help: item.help,
    keys: item.keys,
    button: item.style ? [item.style, item.selected ?? null] : undefined,
    filter: item.filter,
  });
}

/** Whether a menu has an item of that name under a path, as easy-menu-item-present-p. */
export function easyMenuItemPresentP(map: string | e8.Keymap, path: string[], name: string): boolean {
  const into = menuAt(map, path);
  return into !== undefined && truthy(itemKeyNamed(into, name));
}

/** Take an item of that name out of a menu, as easy-menu-remove-item. */
export function easyMenuRemoveItem(map: string | e8.Keymap, path: string[], name: string): void {
  const into = menuAt(map, path);
  if (into === undefined) {
    return;
  }
  const key = itemKeyNamed(into, name);
  if (key !== undefined) {
    e8.keymapUnset(into, key, true);
  }
}
