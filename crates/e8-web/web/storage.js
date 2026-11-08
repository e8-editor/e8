// Keeps E8's files in the browser's Origin Private File System, so they
// survive a reload. The editor's file system is a tree in memory (e8-core's
// vfs.rs); the page fills it from here before the editor starts, and the
// editor's worker sends each change, which is applied here in order.
//
// A path is kept at the same path in OPFS: /home/e8/notes/todo.org is
// home/e8/notes/todo.org there.

async function root() {
  return navigator.storage.getDirectory();
}

// The directory handle for the parts of a path, made if `create`.
async function dirOf(parts, create) {
  let dir = await root();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

function split(path) {
  return path.split("/").filter((p) => p);
}

// Every file and directory kept, as [path, bytes], directories as [path + "/", null].
export async function load() {
  const out = [];
  async function walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix + "/" + name;
      if (handle.kind === "directory") {
        out.push([path + "/", null]);
        await walk(handle, path);
      } else {
        const file = await handle.getFile();
        out.push([path, new Uint8Array(await file.arrayBuffer())]);
      }
    }
  }
  try {
    await walk(await root(), "");
  } catch (e) {
    console.warn("E8 could not read its saved files:", e);
  }
  return out;
}

async function apply({ op, path, data }) {
  const parts = split(path);
  if (op === "mkdir") {
    await dirOf(parts, true);
  } else if (op === "write") {
    const dir = await dirOf(parts.slice(0, -1), true);
    const handle = await dir.getFileHandle(parts.at(-1), { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } else if (op === "remove") {
    try {
      const dir = await dirOf(parts.slice(0, -1), false);
      await dir.removeEntry(parts.at(-1), { recursive: true });
    } catch (e) {
      if (e.name !== "NotFoundError") throw e;
    }
  }
}

// Changes are applied one after another, as the editor made them.
let queue = Promise.resolve();
export function change(c) {
  queue = queue.then(() => apply(c)).catch((e) => console.warn("E8 could not save", c.path, e));
}

// Forgets every file, for a fresh start.
export async function clear() {
  const dir = await root();
  for await (const name of dir.keys()) {
    await dir.removeEntry(name, { recursive: true });
  }
}
