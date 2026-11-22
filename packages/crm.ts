// Reading several answers with completion, after Emacs's crm.el:
// completing-read-multiple reads strings separated by what crm-separator
// matches, completing the one at point, and returns them as a list.
//
// Copyright (C) 1985-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

e8.defineVariable({
  name: "crm-separator",
  doc: "Separator regexp used for separating strings in `completing-read-multiple'.\nIt should be a regexp that does not match the list of completion candidates.",
  value: "[ \t]*,[ \t]*",
});

/** INPUT split where SEPARATOR, an Emacs regexp, matches, the empty strings left out, as split-string with OMIT-NULLS. */
function splitBy(input: string, separator: string): string[] {
  const parts: string[] = [];
  let [last, from] = [0, 0];
  const chars = [...input];
  for (;;) {
    const m = from <= chars.length ? e8.stringMatch(separator, input, { start: from }) : undefined;
    if (m === undefined) break;
    const [start, end] = [m, e8.matchEnd(0) as number];
    if (end === start) {
      from = end + 1;
      continue;
    }
    parts.push(chars.slice(last, start).join(""));
    [last, from] = [end, end];
  }
  parts.push(chars.slice(last).join(""));
  return parts.filter((p) => p !== "");
}

/**
 * Reads several strings in the minibuffer, with completion, as Emacs's
 * completing-read-multiple: separated by what crm-separator matches,
 * completion working on the one at point, each one of the completions
 * with `requireMatch`. Returns them, the empty ones left out; empty input
 * gives the default.
 */
export function completingReadMultiple(prompt: string, table: e8.CompletionTable, options: e8.CompletingReadOptions = {}): string[] {
  const separator = String(e8.variable("crm-separator") ?? "[ \t]*,[ \t]*");
  const input = e8.completingRead(prompt, table, { ...options, separator });
  return splitBy(input, separator);
}

// For code that calls it by name, as Lisp calls completing-read-multiple.
// PREDICATE is not taken, as E8's prompts filter no names; DEF may be a list, its first the default, and INITIAL a cons, its string the input.
e8.defun("completing-read-multiple", (prompt: string, table: string[], _predicate?: e8.Value, requireMatch?: e8.Value, initial?: e8.Value, history?: string, def?: e8.Value) =>
  completingReadMultiple(prompt, table, {
    requireMatch: requireMatch !== null && requireMatch !== undefined && requireMatch !== false,
    initial: typeof initial === "string" ? initial : Array.isArray(initial) && typeof initial[0] === "string" ? initial[0] : undefined,
    history: history ?? undefined,
    default: typeof def === "string" ? def : Array.isArray(def) && typeof def[0] === "string" ? def[0] : undefined,
  }),
);
