// What Org's files share, after Org's org-macs.el: markers placed by
// Org's own rules when it replaces text, and the edits that keep them.

import { eraseBuffer } from "subr";

/**
 * A marker of the core's, as Emacs's: it moves with every edit to its
 * buffer, however made. Setting `pos` moves it into the current buffer,
 * as move-marker does.
 */
export type Marker = { readonly id: e8.Marker; pos: number };

/** This package's markers, for the edits that place them by a rule of their own, as replace-match does. */
export const markers: Marker[] = [];

/** Markers that outlive the command that made them, as Org's org-last-indent-begin-marker, which the sweep below leaves. */
const lasting = new Set<Marker>();

/** A marker kept across commands, until dropped. */
export function lastingMarker(pos: number, advances = false): Marker {
  const m = marker(pos, advances);
  lasting.add(m);
  return m;
}

export function marker(pos: number, advances = false): Marker {
  const id = e8.makeMarker(pos, { advances });
  const m: Marker = {
    id,
    get pos() {
      return e8.markerPosition(id) ?? 0;
    },
    set pos(p: number) {
      e8.setMarker(id, p, e8.bufferName());
    },
  };
  markers.push(m);
  return m;
}

export function dropMarker(m: Marker): void {
  const i = markers.indexOf(m);
  if (i < 0) return;
  markers.splice(i, 1);
  lasting.delete(m);
  e8.deleteMarker(m.id);
}

// A marker made here lives only while the command that made it runs, unless
// made with lastingMarker. One
// an error or a quit left behind, before the command dropped it, would be
// moved on every later edit; it is dropped once the outermost command is
// over, when no prompt or recursive edit keeps a command waiting partway.
e8.addHook("post-command-hook", () => {
  if (markers.length === lasting.size || e8.minibufferDepth() > 0 || e8.recursionDepth() > 0) return;
  for (const m of [...markers]) if (!lasting.has(m)) dropMarker(m);
});

/** Whether the region is active and not empty, as org-region-active-p asks. */
export function orgRegionActive(): boolean {
  const mark = e8.mark();
  return e8.regionActive() && mark !== undefined && mark !== e8.point();
}

/** The line a position is on, point's by default. */
export function lineAt(pos = e8.point()): number {
  return e8.lineOf(pos);
}

/** Where a line starts, or the end of the buffer past the last line. */
export function lineStartOrEnd(line: number): number {
  return line < e8.lineCount() ? e8.lineStart(line) : e8.bufferSize();
}

/** The character at a position, or "" outside the buffer. */
export function charAt(pos: number): string {
  return pos >= 0 && pos < e8.bufferSize() ? e8.bufferText(pos, pos + 1) : "";
}

/** Puts this package's markers in the current buffer where `moved` says, after an edit that moved them its own way. */
export function placeMarkers(saved: [Marker, number][]): void {
  const here = e8.bufferName();
  for (const [m, p] of saved) if (e8.markerBuffer(m.id) === here) m.pos = p;
}

/**
 * A heading's title without the statistics cookies before and after it, as
 * org-complex-heading-regexp-format lets a title be matched with them:
 * "Tasks [1/3]" is the heading "Tasks".
 */
export function titleWithoutCookies(title: string): string {
  return title.replace(/^(?:\[[0-9%/]+\] *)*/, "").replace(/(?: *\[[0-9%/]+\])*$/, "");
}

export function edInsert(pos: number, text: string, beforeMarkers = false): void {
  if (text === "") return;
  e8.gotoChar(pos);
  if (beforeMarkers) e8.insertBeforeMarkers(text);
  else e8.insert(text);
}

/**
 * Deletes from `from` to `to`, kept to the accessible text, as Org's
 * deletions to (line-beginning-position 2) and the like stop at a
 * narrowing's edges; code that means the whole buffer widens first.
 */
export function edDelete(from: number, to: number): string {
  [from, to] = [Math.max(from, e8.pointMin()), Math.min(to, e8.pointMax())];
  if (to <= from) return "";
  return e8.deleteRegion(from, to);
}


/** Scrolls *Org Select* for a key, as org-scroll: a line with C-n and C-p, a screen with C-v and M-v, saying so at either end. */
function mksScroll(key: string): void {
  const down = key === "C-n" || key === "C-v";
  if (e8.posVisibleInWindowP(down ? e8.pointMax() : e8.pointMin()) !== undefined) {
    e8.message(down ? "End of buffer" : "Beginning of buffer");
    return;
  }
  const command = down ? "scroll-up-command" : "scroll-down-command";
  // A line ignores errors, as org-scroll's ignore-errors around (scroll-up 1).
  if (key === "C-n" || key === "C-p") e8.conditionCase(() => e8.callWithPrefix(1, command), { error: () => undefined });
  else e8.call(command);
}

/**
 * Asks for one of a table's entries by its keys, a key at a time, as
 * org-mks does: *Org Select* lists the entries and prefixes a key can
 * choose, under `title`; a prefix, an entry of a key and a description
 * only, lists those under it. Returns the entry, or for one of `specials`
 * its key; C-g aborts.
 */
export function orgMks(table: e8.Value[][], title: string, prompt = "Select: ", specials: [string, string][] = []): e8.Value[] | string {
  const name = "*Org Select*";
  return e8.saveWindowExcursion(() => {
    e8.call("switch-to-buffer-other-window", name);
    try {
      let current = "";
      for (;;) {
        const allowed = new Set<string>();
        const prefixes = new Set<string>();
        let text = `${title}\n\n`;
        const prefix = current === "" ? "" : `${current} `;
        for (const entry of table) {
          const key = String(entry[0] ?? "");
          if (!key.startsWith(current) || [...key].length !== [...current].length + 1) continue;
          const k = [...key].at(-1)!;
          if (entry.length === 2) {
            prefixes.add(k);
            allowed.add(k === " " || k === "\r" ? "\t" : k);
            text += `${prefix}[${k}]...  ${String(entry[1])}...\n`;
          } else if (entry.length > 2) {
            allowed.add(k);
            text += `${prefix}[${k}]     ${String(entry[1])}\n`;
          }
        }
        if (specials.length > 0) {
          text += `${"-".repeat(79)}\n`;
          for (const [key, description] of specials) {
            text += `[${key}]     ${description}\n`;
            allowed.add(key);
          }
        }
        e8.letBind({ "inhibit-read-only": true }, () => {
          eraseBuffer();
          e8.insert(text);
        });
        e8.gotoChar(0);
        e8.call("shrink-window-if-larger-than-buffer");
        // A menu taller than its window can be scrolled, as org--mks-read-key and org-scroll let it.
        const navigation = e8.posVisibleInWindowP(Math.max(e8.pointMax() - 1, 0)) === undefined;
        e8.makeLocalVariable("header-line-format");
        e8.setVariable("header-line-format", navigation ? "Use C-n, C-p, C-v, M-v to navigate." : null);
        let pressed: string;
        for (;;) {
          const key = e8.readKey(prompt);
          if (navigation && (key === "C-n" || key === "C-p" || key === "C-v" || key === "M-v")) {
            mksScroll(key);
            continue;
          }
          pressed = key === "SPC" || key === "TAB" || key === "RET" ? "\t" : key;
          if (pressed === "C-g" || allowed.has(pressed)) break;
          e8.message(`Invalid key: ‘${pressed}’`);
        }
        if (pressed === "C-g") e8.userError("Abort");
        current += pressed;
        if (prefixes.has(pressed)) continue;
        const entry = table.find((e) => e[0] === current);
        if (entry) return entry;
        if (specials.some(([k]) => k === current)) return current;
        e8.signal("error", "No entry available");
      }
    } finally {
      if (e8.bufferList().includes(name)) e8.call("kill-buffer", name);
    }
  });
}
