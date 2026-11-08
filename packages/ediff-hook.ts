// Ediff's entry points, preloaded, after Emacs's ediff-hook.el and the
// autoloads of ediff.el: ediff itself (ediff.ts) loads only when one of its
// commands is first used, as Emacs autoloads it. Each command here prompts
// as ediff's does, loads ediff, whose command of the same name then takes
// this one's place, and runs that with the answers.

/** The file the current buffer visits, without its directory, as ediff-get-default-file-name finds it outside Dired. */
function defaultFileName(): string | undefined {
  const file = e8.bufferFileName();
  return file === undefined ? undefined : e8.fileNameNondirectory(file);
}

/**
 * A buffer to offer as the default, as ediff-other-buffer chooses one: a
 * visible buffer not among `exclude`, preferring the current one, then
 * any other, leaving out those whose names start with a space or a star.
 */
export function ediffOtherBuffer(exclude: string[]): string {
  const significant = (name: string) => !exclude.includes(name) && !/^[ *]/.test(name);
  const current = e8.bufferName();
  const visible = new Set(e8.windowList().map((w) => e8.windowBuffer(w)));
  const list = e8.bufferList();
  return (
    (significant(current) && visible.has(current) ? current : undefined) ??
    list.find((name) => visible.has(name) && significant(name)) ??
    list.find(significant) ??
    "*scratch*"
  );
}

/** A prompt as format-prompt makes it: "Buffer A to compare (default foo): ". */
const formatPrompt = (prompt: string, def: string | undefined) => (def ? `${prompt} (default ${def}): ` : `${prompt}: `);

/** A buffer parameter that offers ediff-other-buffer of the buffers read before it. */
function bufferParam(name: string, prompt: string): e8.Param {
  return { name, kind: "buffer", prompt: (...earlier: string[]) => formatPrompt(prompt, ediffOtherBuffer(earlier)) };
}

/**
 * A file parameter read as ediff-read-file-name reads it: in the directory
 * of the file read before it, the default being that file's name there or,
 * for the first, the current buffer's file.
 */
function fileParam(name: string, prompt: string): e8.Param {
  return {
    name,
    kind: "file",
    prompt: (...earlier: string[]) => {
      const before = earlier[earlier.length - 1];
      const def = before === undefined ? defaultFileName() : e8.fileNameNondirectory(before);
      return formatPrompt(prompt, def);
    },
    initial: (...earlier: string[]) => {
      const before = earlier[earlier.length - 1];
      return before === undefined ? "" : e8.abbreviateFileName(e8.fileNameDirectory(e8.expandFileName(before)) ?? "");
    },
  };
}

/** Ediff's commands, with the parameters they prompt for: what ediff.ts defines them with too. */
export const ediffCommands: { name: string; doc: string; params: e8.Param[] }[] = [
  { name: "ediff-files", doc: "Compare two files in Ediff, visiting them.", params: [fileParam("file-A", "File A to compare"), fileParam("file-B", "File B to compare")] },
  { name: "ediff-files3", doc: "Compare three files in Ediff, visiting them.", params: [fileParam("file-A", "File A to compare"), fileParam("file-B", "File B to compare"), fileParam("file-C", "File C to compare")] },
  { name: "ediff-buffers", doc: "Compare two buffers in Ediff, as they are, saved or not.", params: [bufferParam("buffer-A", "Buffer A to compare"), bufferParam("buffer-B", "Buffer B to compare")] },
  { name: "ediff-buffers3", doc: "Compare three buffers in Ediff, as they are.", params: [bufferParam("buffer-A", "Buffer A to compare"), bufferParam("buffer-B", "Buffer B to compare"), bufferParam("buffer-C", "Buffer C to compare")] },
  { name: "ediff-merge-files", doc: "Merge two files in Ediff, into a buffer of its own that starts with every difference combined.", params: [fileParam("file-A", "File A to merge"), fileParam("file-B", "File B to merge")] },
  { name: "ediff-merge-files-with-ancestor", doc: "Merge two files that each changed a third, their ancestor, in Ediff: what only one changed is taken from it, and what both changed is combined.", params: [fileParam("file-A", "File A to merge"), fileParam("file-B", "File B to merge"), fileParam("file-ancestor", "Ancestor file")] },
  { name: "ediff-merge-buffers", doc: "Merge two buffers in Ediff, as ediff-merge-files merges files.", params: [bufferParam("buffer-A", "Buffer A to merge"), bufferParam("buffer-B", "Buffer B to merge")] },
  { name: "ediff-merge-buffers-with-ancestor", doc: "Merge two buffers that each changed a third, their ancestor, in Ediff, as ediff-merge-files-with-ancestor merges files.", params: [bufferParam("buffer-A", "Buffer A to merge"), bufferParam("buffer-B", "Buffer B to merge"), bufferParam("buffer-ancestor", "Ancestor buffer")] },
];

for (const { name, doc, params } of ediffCommands) {
  // Replaced by ediff.ts's command of the same name when it loads.
  e8.defineCommand({
    name,
    doc,
    params,
    run: (...args: string[]) => {
      e8.require("ediff");
      e8.call(name as e8.DefinedCommand, ...args);
    },
  });
}

for (const [alias, command] of [
  ["ediff", "ediff-files"],
  ["ediff3", "ediff-files3"],
  ["ebuffers", "ediff-buffers"],
  ["ebuffers3", "ediff-buffers3"],
  ["ediff-merge", "ediff-merge-files"],
  ["ediff-merge-with-ancestor", "ediff-merge-files-with-ancestor"],
]) {
  e8.defalias(alias, command);
}
