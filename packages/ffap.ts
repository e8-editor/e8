// Finding the file named at point, after Emacs's ffap.el. find-file-at-point
// (also ffap) takes the file name around point, if it names a file that is
// there, as the starting input of a find-file prompt. Emacs also guesses
// from URLs, mail addresses and library names; E8 only from file names.

import { browseUrl } from "browse-url";

/** The characters a file name at point may have, as ffap-string-at-point-mode-alist's file entry, for skip-chars. */
const FILE_CHARS = "-~/A-Za-z0-9_.${}#%,:+@*?<>[]";

/** The text around point that could be a file name, without punctuation around it, as ffap-string-at-point. */
function stringAtPoint(): string {
  let s = e8.saveExcursion(() => {
    const point = e8.point();
    const start = point + e8.skipCharsBackward(FILE_CHARS);
    e8.gotoChar(point);
    const end = point + e8.skipCharsForward(FILE_CHARS);
    return e8.bufferText(start, end);
  });
  s = s.replace(/^[<@]+/, "").replace(/[@>;.,!:]+$/, "");
  return s;
}

/** The file named at point, if it is there, as ffap-file-at-point: a line number after a colon is left off. */
function fileAtPoint(): string | undefined {
  const s = stringAtPoint();
  if (s === "") return undefined;
  for (const candidate of [s, s.replace(/:\d+(:\d+)?$/, "")]) {
    const file = e8.expandFileName(candidate);
    if (e8.fileExists(file)) return file;
  }
  return undefined;
}

const findFileAtPoint = e8.defineCommand({
  name: "find-file-at-point",
  doc:
    "Visit a file, starting from the name of the file at point, if there is one.\n\n" +
    "The name may be relative to the buffer's directory, and a line number after a colon is left off.",
  params: [{
    name: "file",
    kind: "file",
    prompt: "Find file or URL: ",
    initial: () => {
      const file = fileAtPoint();
      if (file === undefined) return e8.abbreviateFileName(e8.fileNameAsDirectory(e8.expandFileName(".")));
      const name = e8.abbreviateFileName(file);
      return e8.fileDirectoryP(file) ? e8.fileNameAsDirectory(name) : name;
    },
  }],
  run: (file: string) => {
    // A URL opens in a browser, as ffap-url-fetcher's browse-url.
    if (/^[a-z]+:\/\//.test(file)) {
      browseUrl(file);
      return;
    }
    e8.call("find-file", file);
  },
});

e8.defineCommand({
  name: "ffap",
  doc: "Visit a file, starting from the name of the file at point, as find-file-at-point does.",
  run: () => e8.callInteractively(findFileAtPoint),
});
