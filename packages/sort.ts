// Sorting and reordering lines, after Emacs's sort.el: sort-lines,
// reverse-region and delete-duplicate-lines.

e8.defineVariable({ name: "sort-fold-case", doc: "Whether sorting ignores the case of letters.", value: false });

/** Sorts `items` by `key`, stably, and the other way round with `reverse`, as sort-subr: equal ones keep their order either way. */
function sortSubr<T>(items: T[], key: (t: T) => string, reverse: boolean): T[] {
  const fold = e8.variable("sort-fold-case") !== false && e8.variable("sort-fold-case") !== null;
  const k = (t: T) => (fold ? key(t).toLowerCase() : key(t));
  const compare = (a: T, b: T) => {
    const [x, y] = [k(a), k(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const list = reverse ? [...items].reverse() : [...items];
  list.sort(compare);
  return reverse ? list.reverse() : list;
}

e8.defineCommand({
  name: "sort-lines",
  doc: "Sort the lines in the region alphabetically; with a prefix argument, the other way round. sort-fold-case says whether case matters.",
  // The region first, as code passes it; Emacs's own order is REVERSE BEG END.
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "reverse", kind: "prefix" },
  ],
  run: (beg: number, end: number, reverse: e8.PrefixArg) => {
    const text = e8.bufferSubstringNoProperties(beg, end);
    const lines = text.split("\n");
    // A newline at the end leaves no record after it.
    const last = text.endsWith("\n") ? lines.pop() : undefined;
    const sorted = sortSubr(lines, (l) => l, reverse !== null);
    const result = sorted.join("\n") + (last !== undefined ? "\n" : "");
    if (result === text) return;
    // The text keeps its length, so the mark stays where it was, as
    // sort-subr's records are replaced in place.
    const mark = e8.mark();
    e8.saveExcursion(() => {
      e8.gotoChar(beg);
      e8.deleteRegion(beg, end);
      e8.insert(result);
    });
    if (mark !== undefined) e8.setMark(mark);
  },
});

e8.defineCommand({
  name: "reverse-region",
  doc: "Reverse the order of the whole lines in the region.",
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
  ],
  run: (begIn: number, endIn: number) => {
    e8.saveExcursion(() => {
      // The largest stretch of whole lines in the region.
      e8.gotoChar(begIn);
      if (e8.point() !== e8.lineBeginningPosition()) e8.gotoChar(Math.min(e8.pointMax(), e8.lineEndPosition() + 1));
      const beg = e8.point();
      e8.gotoChar(endIn);
      const eolp = e8.point() === e8.lineEndPosition();
      const bolp = e8.point() === e8.lineBeginningPosition();
      if (!(eolp && !bolp)) {
        e8.gotoChar(e8.lineBeginningPosition());
        if (e8.point() > e8.pointMin()) e8.gotoChar(e8.point() - 1);
        e8.gotoChar(e8.lineEndPosition());
      }
      const end = e8.point();
      if (end <= beg) e8.userError("There are no full lines in the region");
      const lines = e8.bufferSubstringNoProperties(beg, end).split("\n");
      e8.deleteRegion(beg, end);
      e8.gotoChar(beg);
      e8.insert(lines.reverse().join("\n"));
    });
  },
});

e8.defineCommand({
  name: "delete-duplicate-lines",
  barfIfReadOnly: true,
  doc:
    "Delete each line in the region that is the same as one before it.\n\n" +
    "With C-u, keep the last of each instead; with C-u C-u, only lines next to each other count; " +
    "with C-u C-u C-u, repeated blank lines stay.",
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "arg", kind: "prefix" },
  ],
  run: (begIn: number, endIn: number, arg: e8.PrefixArg) => {
    const is = (n: number) => Array.isArray(arg) && arg[0] === n;
    const [reverse, adjacent, keepBlanks] = [is(4), is(16), is(64)];
    const seen = new Set<string>();
    let prev: string | undefined;
    let count = 0;
    const beg = e8.makeMarker(begIn);
    const end = e8.makeMarker(endIn);
    const bolp = () => e8.point() === e8.lineBeginningPosition();
    const forwardLine = (n: number) => {
      const line = e8.lineOf(e8.point()) + n;
      e8.gotoChar(line < 0 ? e8.pointMin() : line >= e8.lineCount() ? e8.pointMax() : e8.lineStart(line));
    };
    e8.saveExcursion(() => {
      e8.gotoChar(reverse ? e8.markerPosition(end)! : e8.markerPosition(beg)!);
      if (reverse && bolp() && e8.point() > e8.pointMin()) e8.gotoChar(e8.point() - 1);
      let first = false;
      while (reverse ? !first : e8.point() < e8.markerPosition(end)! && e8.point() < e8.pointMax()) {
        first = reverse && (e8.point() <= e8.markerPosition(beg)! || e8.point() === e8.pointMin());
        const line = e8.bufferSubstringNoProperties(e8.lineBeginningPosition(), e8.lineEndPosition());
        if (keepBlanks && line === "") {
          forwardLine(1);
          continue;
        }
        if (adjacent ? line === prev : seen.has(line)) {
          const from = e8.lineBeginningPosition();
          forwardLine(1);
          e8.deleteRegion(from, e8.point());
          if (reverse) forwardLine(-1);
          count++;
        } else {
          if (adjacent) prev = line;
          else seen.add(line);
          forwardLine(reverse ? -1 : 1);
        }
      }
    });
    e8.deleteMarker(beg);
    e8.deleteMarker(end);
    e8.message(`Deleted ${count} ${adjacent ? "adjacent " : ""}duplicate line${count === 1 ? "" : "s"}${reverse ? " backward" : ""}`);
  },
});
