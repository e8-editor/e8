// Compositions, after Emacs's composite.el: showing a stretch of text as
// other characters, through the `composition` text property the core's
// composeRegionInternal puts (ADR 0092). prettify-symbols-mode, in
// prog-mode.ts, is what uses them most.

type Components = number | string | e8.Value[] | null | undefined;

/** Run `fn` leaving the buffer's modified flag as it was, as composite.el's functions do. */
function keepingModified<T>(fn: () => T): T {
  const modified = e8.bufferModified();
  try {
    return fn();
  } finally {
    e8.setBufferModified(modified);
  }
}

/**
 * Compose the text from start to end, as compose-region: show it as
 * `components`, a character, a string, or characters and composition
 * rules alternating, or as its own characters drawn together with none.
 * The buffer stays as modified as it was.
 */
export function composeRegion(start: number, end: number, components?: Components, modificationFunc?: e8.Value): void {
  keepingModified(() => e8.composeRegionInternal(start, end, components ?? null, modificationFunc ?? null));
}

/** Take the compositions off the text from start to end, as decompose-region. */
export function decomposeRegion(start: number, end: number): void {
  keepingModified(() => e8.removeTextProperty(start, end, "composition"));
}

/** The string with its characters from start to end composed, as compose-string. */
export function composeString(string: string | e8.Value, start = 0, end?: number | null, components?: Components, modificationFunc?: e8.Value): e8.Value {
  const length = [...String(string)].length;
  return e8.composeStringInternal(string, start, end ?? length, components ?? null, modificationFunc ?? null);
}

/** The string without its compositions, as decompose-string. */
export function decomposeString(string: string | e8.Value): e8.Value {
  const s = string instanceof e8.PropertizedString ? string : new e8.PropertizedString(String(string));
  const runs: [number, number, Record<string, e8.Value>][] = [];
  for (const [start, end, props] of s.properties as [number, number, Record<string, e8.Value>][]) {
    const { composition: _, ...rest } = props;
    if (Object.keys(rest).length > 0) runs.push([start, end, rest]);
  }
  return new e8.PropertizedString(s.string, runs);
}

/** A string of the characters given, composed as one, as compose-chars without rules. */
export function composeChars(...chars: (number | string)[]): e8.Value {
  const string = chars.map((c) => (typeof c === "number" ? String.fromCodePoint(c) : c)).join("");
  return composeString(string);
}

/**
 * The composition at pos, or the nearest one between it and limit, in the
 * buffer or in `string`, as find-composition: [start, end, true], or with
 * detail [start, end, components, relative, modfunc, width].
 */
export function findComposition(pos: number, limit?: number | null, string?: string | e8.Value | null, detailP?: boolean): e8.Value[] | undefined {
  return e8.findCompositionInternal(pos, limit ?? null, string ?? null, detailP ?? null);
}

e8.defineCommand({
  name: "compose-region",
  doc: "Show the text in the region as its characters drawn together, or as other characters when code gives them.",
  params: [{ name: "start", kind: "region-beginning" }, { name: "end", kind: "region-end" }],
  run: (start: number, end: number) => composeRegion(start, end),
});
e8.defineCommand({
  name: "decompose-region",
  doc: "Show the text in the region as itself again, taking off its compositions.",
  params: [{ name: "start", kind: "region-beginning" }, { name: "end", kind: "region-end" }],
  run: (start: number, end: number) => decomposeRegion(start, end),
});
