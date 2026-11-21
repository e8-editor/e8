// Going to a place in an Org buffer, after Org's org-goto.el: C-c C-j shows
// a copy of the buffer folded to its top headings, an indirect buffer, in
// which the arrows, TAB and isearch over the headings find the place, and
// RET goes there in the buffer itself, its folding as it was; or, with
// org-goto-interface outline-path-completion, the place is completed as
// org-refile completes its targets.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { headingIndex, headings, markRingPush } from "org";
import { isearchMode } from "isearch";
import { overview, showContext, showSetVisibility } from "org-fold";
import { lineAt } from "org-macs";
import { getLocation } from "org-refile";
import { eraseBuffer, truthy } from "subr";
import { fitWindowToBuffer, quitWindow } from "window";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar(
  "org-goto-interface",
  "outline",
  'How org-goto finds the place: "outline", in a folded copy of the buffer, or "outline-path-completion", completing the headings\' outline paths as org-refile does.',
);
defvar("org-goto-max-level", 5, "The deepest headings org-goto offers with outline-path-completion.");
defvar(
  "org-goto-auto-isearch",
  true,
  "Whether typing in org-goto's copy of the buffer starts an isearch of its headings. When false, q quits, n and p go to the next and previous heading, f and b to the next and previous of the same level, and u up.",
);

const HELP =
  "Browse buffer copy, to find location or copy text.%s\n" +
  "RET=jump to location             C-g=quit and return to previous location\n" +
  "[Up]/[Down]=next/prev headline   TAB=cycle visibility   [/] org-occur";

/** Where org-goto's copy was left, and how, as org-goto-selected-point and org-goto-exit-command. */
let selectedPoint: number | undefined;
let exitCommand: string | undefined;
/** Where point was when org-goto began, as org-goto-start-pos. */
let startPos: number | undefined;

e8.defineKeymap("org-goto-map");

/** Sets up org-goto-map, as org-goto--set-map: for typing to search, or for single-key motion. */
function setMap(): void {
  const map = "org-goto-map";
  const auto = truthy(e8.variable("org-goto-auto-isearch"));
  // The keys the global map gives these, as substitute-key-definition copies them.
  for (const cmd of ["isearch-forward", "isearch-backward", "kill-ring-save", "set-mark-command", "universal-argument", "org-occur"]) {
    for (const keys of e8.whereIsInternal(cmd)) e8.defineKey(map, keys, cmd as e8.CommandName);
  }
  // Typed characters search, or else are undefined, digits giving a count, as suppress-keymap.
  e8.setKeymapDefault(map, auto ? "org-goto-local-auto-isearch" : null);
  e8.remapCommand(map, "self-insert-command", auto ? null : "undefined");
  // A key taken out rather than bound to nil, which would let the global map's binding through, as Emacs's fresh map has none.
  const bind = (keys: string, command: e8.CommandName | null) => (command === null ? e8.keymapUnset(map, keys, true) : e8.defineKey(map, keys, command));
  for (let d = 0; d <= 9; d++) bind(String(d), auto ? null : "digit-argument");
  bind("-", auto ? null : "negative-argument");
  for (const [keys, command] of [
    ["RET", "org-goto-ret"],
    ["<return>", "org-goto-ret"],
    ["<left>", "org-goto-left"],
    ["<right>", "org-goto-right"],
    ["C-g", "org-goto-quit"],
    ["TAB", "org-cycle"],
    ["<tab>", "org-cycle"],
    ["<down>", "outline-next-visible-heading"],
    ["<up>", "outline-previous-visible-heading"],
    ["/", "org-occur"],
    ["C-c C-n", "outline-next-visible-heading"],
    ["C-c C-p", "outline-previous-visible-heading"],
    ["C-c C-f", "outline-forward-same-level"],
    ["C-c C-b", "outline-backward-same-level"],
    ["C-c C-u", "outline-up-heading"],
  ] as const) {
    e8.defineKey(map, keys, command);
  }
  for (const [keys, command] of [
    ["q", "org-goto-quit"],
    ["n", "outline-next-visible-heading"],
    ["p", "outline-previous-visible-heading"],
    ["f", "outline-forward-same-level"],
    ["b", "outline-backward-same-level"],
    ["u", "outline-up-heading"],
  ] as const) {
    bind(keys, auto ? null : command);
  }
}

/**
 * Searches for `string` as isearch does, but only in headings' text before
 * their tags, as org-goto--local-search-headings: point goes to the match.
 */
function searchHeadings(string: string, bound?: e8.Value, noerror?: e8.Value): number | undefined {
  const forward = truthy(e8.variable("isearch-forward"));
  const caseFold = truthy(e8.variable("case-fold-search"));
  const re = string.replace(/[[*.\\?+^$]/g, "\\$&");
  const limit = typeof bound === "number" ? bound : undefined;
  for (;;) {
    const found = forward
      ? e8.searchForwardRegexp(re, { bound: limit, noerror: true, caseFold })
      : e8.searchBackwardRegexp(re, { bound: limit, noerror: true, caseFold });
    if (found === undefined) {
      if (!truthy(noerror)) e8.signal("search-failed", `Search failed: "${string}"`, [string]);
      return undefined;
    }
    const all = headings();
    const i = headingIndex(all, lineAt());
    const h = i === undefined ? undefined : all[i];
    if (h !== undefined && h.line === lineAt() && (h.tagsAt === undefined || e8.point() < h.tagsAt)) return e8.point();
  }
}
e8.defun("org-goto--search-fun", () => searchHeadings);

e8.defineCommand({
  name: "org-goto-local-auto-isearch",
  doc: "Start an isearch of the headings with the character typed.",
  run: () => {
    const keys = e8.thisCommandKeys();
    // A character isearch would add to its string: one that would insert itself.
    if (keys === "SPC" || [...keys].length === 1) {
      isearchMode(true);
      e8.unreadKeys(keys);
    }
  },
});

/** Ends org-goto's recursive edit, as its commands throw to exit. */
function finish(point: number | undefined, command: string): void {
  selectedPoint = point;
  exitCommand = command;
  e8.call("exit-recursive-edit");
}

/** Whether point is on a heading line, as org-at-heading-p. */
function atHeading(): boolean {
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i !== undefined && all[i].line === lineAt();
}

e8.defineCommand({ name: "org-goto-ret", doc: "Finish org-goto by going to the place point is at.", run: () => finish(e8.point(), "return") });

e8.defineCommand({
  name: "org-goto-left",
  doc: "Finish org-goto by going to the heading point is on, at its start.",
  run: () => {
    if (!atHeading()) e8.userError("Not on a heading");
    finish(e8.lineStart(lineAt()), "left");
  },
});

e8.defineCommand({
  name: "org-goto-right",
  doc: "Finish org-goto by going to the heading point is on.",
  run: () => {
    if (!atHeading()) e8.userError("Not on a heading");
    finish(e8.point(), "right");
  },
});

e8.defineCommand({ name: "org-goto-quit", doc: "Finish org-goto where point was, not moving it.", run: () => finish(undefined, "quit") });

/**
 * Lets the place be chosen in a copy of the buffer, as org-goto-location:
 * an indirect buffer, *org-goto*, folded to its top headings, read-only,
 * with org-goto-map, and *Org Help* below it. Returns the place chosen, if
 * any, and how org-goto's copy was left.
 */
export function gotoLocation(help = HELP): [number | undefined, string | undefined] {
  selectedPoint = undefined;
  exitCommand = undefined;
  const base = e8.currentBuffer();
  e8.saveExcursion(() =>
    e8.saveWindowExcursion(() => {
      if (e8.getBuffer("*org-goto*") !== undefined) e8.call("kill-buffer", "*org-goto*");
      const copy = e8.makeIndirectBuffer(base, "*org-goto*", true);
      // The whole frame, as org-display-buffer-full-frame.
      e8.call("delete-other-windows");
      e8.call("switch-to-buffer", "*org-goto*");
      const helpBuffer = e8.getBufferCreate("*Org Help*");
      e8.withCurrentBuffer(helpBuffer, () => {
        e8.setReadOnly(false);
        eraseBuffer();
        e8.insert(help.replace("%s", truthy(e8.variable("org-goto-auto-isearch")) ? "  Just type for auto-isearch." : "  n/p/f/b/u to navigate, q to quit."));
        e8.gotoChar(0);
      });
      const helpWindow = e8.splitWindow(e8.selectedWindow(), "below");
      e8.setWindowBuffer(helpWindow, "*Org Help*");
      fitWindowToBuffer(helpWindow);
      overview();
      e8.setReadOnly(true);
      e8.makeLocalVariable("isearch-search-fun-function");
      e8.setVariable("isearch-search-fun-function", "org-goto--search-fun");
      if (startPos !== undefined) {
        e8.gotoChar(startPos);
        if (e8.invisibleAt(e8.point())) showSetVisibility("lineage");
      } else e8.gotoChar(e8.pointMin());
      e8.gotoChar(e8.lineStart(lineAt()));
      e8.message("Select location and press RET");
      e8.useLocalMap("org-goto-map");
      try {
        e8.recursiveEdit();
      } finally {
        if (e8.windowLiveP(helpWindow)) quitWindow(true, helpWindow);
      }
    }),
  );
  if (e8.getBuffer("*org-goto*") !== undefined) e8.call("kill-buffer", "*org-goto*");
  return [selectedPoint, exitCommand];
}

e8.defineCommand({
  name: "org-goto",
  doc:
    "Go to another place in this buffer, keeping its folding: find it in a copy folded to its top headings, with the arrows, " +
    "TAB and isearch of the headings, and press RET, or C-g to stay. With org-goto-interface outline-path-completion, or the " +
    "other with a prefix argument, complete a heading's outline path instead. Org's mark ring remembers where point was.",
  params: [{ name: "alternative", kind: "prefix" }],
  run: (alternative) => {
    setMap();
    const setting = e8.variable("org-goto-interface") === "outline-path-completion" ? "outline-path-completion" : "outline";
    const iface = alternative === null || alternative === undefined ? setting : setting === "outline" ? "outline-path-completion" : "outline";
    const start = e8.point();
    startPos = start;
    let selected: number | undefined;
    try {
      if (iface === "outline") selected = gotoLocation()[0];
      else {
        // The headings down to org-goto-max-level, by their outline paths, as org-goto binds the refile options.
        const found = e8.letBind(
          {
            "org-refile-targets": [[null, ":maxlevel", Number(e8.variable("org-goto-max-level") ?? 5)]],
            "org-refile-use-outline-path": true,
            "org-refile-target-verify-function": null,
          },
          () => getLocation("Goto"),
        );
        const target = found?.[1].start;
        selected = target === undefined ? undefined : typeof target === "number" ? target : (e8.markerPosition(target) ?? undefined);
      }
    } finally {
      startPos = undefined;
    }
    if (selected === undefined) {
      e8.message("Quit");
      return;
    }
    markRingPush(start);
    e8.gotoChar(selected);
    if (e8.invisibleAt(e8.point())) showContext("org-goto");
  },
});
