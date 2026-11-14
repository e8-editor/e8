// Watching files for changes on disk, after Emacs's filenotify.el: one
// way to watch a file or directory, file-notify-add-watch, over the
// back end the system has. E8 has Emacs's kqueue back end (kqueue.c), on
// macOS and the BSDs; elsewhere there is none, and adding a watch signals
// file-notify-error. There are no file name handlers, so no remote watches.

/** A watch: the directory, the file in it, or undefined for the directory itself, and the callback, undefined once the watch is being removed. */
interface Watch {
  directory: string;
  filename: string | undefined;
  callback: ((event: e8.Value[]) => unknown) | string | undefined;
}

type Event = [number, string, string] | [number, string, string, string];

/** The watches by descriptor, as file-notify-descriptors. */
const descriptors = new Map<number, Watch>();

e8.defineError("file-notify-error", "file-error");

e8.defineVariable({ name: "file-notify-debug", doc: "Use for debug messages.", value: false });

function absoluteFilename(watch: Watch): string {
  return watch.filename ? e8.expandFileName(watch.filename, watch.directory) : watch.directory;
}

function expandName(watch: Watch, file: string): string {
  return e8.directoryFileName(e8.expandFileName(file, watch.directory));
}

function call(callback: Watch["callback"], event: Event): void {
  if (callback) e8.funcall(callback, event);
}

/** Removes a descriptor and sends its watch's callback a stopped event, as file-notify--rm-descriptor. */
function rmDescriptor(descriptor: number): void {
  const watch = descriptors.get(descriptor);
  if (!watch) return;
  try {
    call(watch.callback, [descriptor, "stopped", absoluteFilename(watch)]);
  } finally {
    // Make sure this is the last time the callback was invoked.
    watch.callback = undefined;
    descriptors.delete(descriptor);
  }
}

/** A rename waiting for its destination, as file-notify--pending-rename. */
let pendingRename: { watch: Watch; desc: number; fromFile: string; cookie: unknown } | undefined;

/** Calls a watch's callback if the event concerns what it watches, as file-notify--call-handler. */
function callHandler(watch: Watch, desc: number, action: string, file: string, file1: string | undefined): void {
  if (
    watch.filename === undefined ||
    watch.filename === e8.fileNameNondirectory(file) ||
    (typeof file1 === "string" && watch.filename === e8.fileNameNondirectory(file1))
  ) {
    if (e8.variable("file-notify-debug")) e8.message(`file-notify-callback ${desc} ${action} ${file} ${file1 ?? "nil"}`);
    call(watch.callback, file1 ? [desc, action, file, file1] : [desc, action, file]);
  }
}

/** Handles an event from the back end, its actions already file-notify's, as file-notify--handle-event. */
function handleEvent(desc: number, actions: string[], rawFile: string, file1OrCookie: unknown): void {
  const watch = descriptors.get(desc);
  if (!watch) return;
  let file = expandName(watch, rawFile);
  for (let i = 0; i < actions.length; i++) {
    let action: string | undefined = actions[i];
    // A pending rename that this event does not finish was a deletion.
    if (pendingRename && !(pendingRename.cookie === file1OrCookie && action === "renamed-to")) {
      const pending = pendingRename;
      call(pending.watch.callback, [pending.desc, "deleted", pending.fromFile]);
      pendingRename = undefined;
    }
    let file1: string | undefined;
    if (action === "renamed") {
      // Without a destination, a rename is a deletion.
      if (typeof file1OrCookie === "string") file1 = expandName(watch, file1OrCookie);
      else action = "deleted";
    } else if (action === "stopped") {
      fileNotifyRmWatch(desc);
      return;
    } else if (action === "renamed-from") {
      pendingRename = { watch, desc, fromFile: file, cookie: file1OrCookie };
      action = undefined;
    } else if (action === "renamed-to") {
      if (pendingRename) {
        const pending = pendingRename;
        file1 = file;
        file = pending.fromFile;
        // The source's own watch hears of the rename too.
        if (pending.desc !== desc) call(pending.watch.callback, [pending.desc, "renamed", file, file1]);
        pendingRename = undefined;
        action = "renamed";
      } else action = "created";
    }
    if (action) callHandler(watch, desc, action, file, file1);
    // What is watched has gone, unless it was only backed up.
    if ((action === "deleted" || action === "renamed") && !(file1 !== undefined && file1.endsWith("~")) && file === absoluteFilename(watch)) {
      fileNotifyRmWatch(desc);
    }
  }
}

/** The kqueue back end's actions as file-notify's, as file-notify--callback-kqueue. */
const KQUEUE_ACTIONS: Record<string, string> = {
  create: "created",
  write: "changed",
  attrib: "attribute-changed",
  link: "attribute-changed",
  delete: "deleted",
  rename: "renamed",
  revoke: "stopped",
};

e8.defun("file-notify--callback-kqueue", (event: [number, string[], string, string?]) => {
  const [desc, actions, file, file1] = event;
  handleEvent(desc, actions.map((a) => KQUEUE_ACTIONS[a]).filter((a): a is string => a !== undefined), file, file1);
});

/**
 * Watch a file or directory for changes, as file-notify-add-watch: `flags`
 * holds "change", for its contents or, for a directory, the files made and
 * deleted in it, and "attribute-change"; `callback` is called with
 * `[descriptor, action, file, file1?]`, action one of "created",
 * "deleted", "changed", "renamed" (to `file1`), "attribute-changed" and
 * "stopped". Returns the watch's descriptor.
 */
export function fileNotifyAddWatch(file: string, flags: string[], callback: ((event: e8.Value[]) => unknown) | string): number {
  if (typeof file !== "string") e8.signal("wrong-type-argument", `Wrong type argument: ${String(file)}`, [file]);
  file = e8.expandFileName(file);
  if (!Array.isArray(flags) || flags.length === 0 || flags.some((f) => f !== "change" && f !== "attribute-change")) {
    e8.signal("wrong-type-argument", `Wrong type argument: ${JSON.stringify(flags)}`, [flags ?? null]);
  }
  if (typeof callback !== "function" && !(typeof callback === "string" && e8.fboundp(callback))) {
    e8.signal("wrong-type-argument", `Wrong type argument: ${String(callback)}`, [callback as e8.Value]);
  }
  const dir = e8.directoryFileName(e8.fileDirectoryP(file) ? file : (e8.fileNameDirectory(file) ?? file));
  if (!e8.fileDirectoryP(dir)) e8.signal("file-notify-error", `Directory does not exist, ${dir}`, ["Directory does not exist", dir]);
  // kqueue does not report changes to the files in a watched directory,
  // so each file is watched itself.
  const desc = e8.kqueueAddWatch(
    file,
    [
      "revoke",
      ...(flags.includes("change") ? ["create", "delete", "write", "extend", "rename"] : []),
      ...(flags.includes("attribute-change") ? ["attrib"] : []),
    ],
    "file-notify--callback-kqueue",
  );
  descriptors.set(desc, { directory: dir, filename: e8.fileDirectoryP(file) ? undefined : e8.fileNameNondirectory(file), callback });
  return desc;
}

/** Stop a watch file-notify-add-watch made, sending its callback a stopped event, as file-notify-rm-watch. */
export function fileNotifyRmWatch(descriptor: number): void {
  const watch = descriptors.get(descriptor);
  // Called from a stopped event, it does nothing.
  if (!watch?.callback) return;
  e8.conditionCase(() => e8.kqueueRmWatch(descriptor), { "file-notify-error": () => true });
  rmDescriptor(descriptor);
}

/** Stop every watch, as file-notify-rm-all-watches. */
export function fileNotifyRmAllWatches(): void {
  for (const descriptor of [...descriptors.keys()]) fileNotifyRmWatch(descriptor);
}

/** Whether a watch file-notify-add-watch made is in place, as file-notify-valid-p. */
export function fileNotifyValidP(descriptor: number): boolean | undefined {
  return descriptors.has(descriptor) && e8.kqueueValidP(descriptor) ? true : undefined;
}

e8.defun("file-notify-add-watch", fileNotifyAddWatch);
e8.defun("file-notify-rm-watch", fileNotifyRmWatch);
e8.defun("file-notify-valid-p", fileNotifyValidP);
e8.defineCommand({
  name: "file-notify-rm-all-watches",
  doc: "Remove all existing file notification watches from Emacs.",
  run: () => fileNotifyRmAllWatches(),
});
