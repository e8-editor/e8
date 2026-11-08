# e8-web: E8 in a browser (a spike)

E8 compiled to WebAssembly: the egui front end draws on a canvas on the
page's main thread, and the editor runs on a Web Worker that shares the
wasm memory, as the native GUI runs it on a thread of its own
([ADR 0051](../../docs/adr/0051-the-editor-thread.md)). Scripts run on
QuickJS. Every package that ships with E8 loads, as with `-q`.

This is a spike, to see what it takes. It is not tested by `make check` or
CI, and it has no ADR yet.

## Running it

```bash
crates/e8-web/build.sh
python3 crates/e8-web/serve.py
```

Then open <http://localhost:8008>. `serve.py` sends the headers that make
the page cross-origin isolated; shared memory needs them, so any host that
serves the page must send them too (`Cross-Origin-Opener-Policy:
same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). Opening
`index.html` as a file does not work.

`build.sh` needs:

- nightly Rust with `rust-src` and `wasm32-unknown-unknown`
  (`rustup toolchain install nightly --component rust-src --target wasm32-unknown-unknown`),
  as std is rebuilt with atomics;
- `wasm-bindgen` at Cargo.lock's version
  (`cargo install wasm-bindgen-cli --version 0.2.129 --locked --bin wasm-bindgen`,
  with `CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc` on a Mac whose
  PATH has Nix's `cc`);
- an LLVM clang that targets wasm, for QuickJS and tree-sitter. Apple's
  does not; the script takes LLVM 20 from Nix, or `WASM_CC`, `WASM_AR` and
  `WASM_RESOURCE_DIR`.

It builds in `target/wasm`, so it never rebuilds the native workspace. A
first build takes several minutes, later ones seconds.

## What works

Typing, the minibuffer and every prompt (each runs its nested command loop
on the worker, as natively: ADR 0053), `M-x` with completion, `C-x b`,
windows (`C-x 2`, `C-x 3`, `C-x o`), isearch, undo, `M-:` evaluating
TypeScript on QuickJS, Org mode with folding and tables, tree-sitter
highlighting (the Python buffer), mouse clicks. Files: visiting, saving,
Dired, renaming and deleting, `M-x load-file`, and `~/.config/e8/init.ts`
if one is written.

## Files

The editor's file system is e8-core's `vfs`: `std::fs` natively, and on
the web a tree in memory with the same interface, which every file
primitive goes through. The person's files are in `/home/e8`, which is
`~` and the starting directory; a first visit puts `welcome.org`,
`example.py`, `notes/ideas.org` and `scripts/hello.ts` there.

`storage.js` keeps the tree in the browser's Origin Private File System:
the page reads it all before the editor starts and fills the tree from
it, and each change the editor makes is posted from its worker to the
page, which applies them in order. Nothing waits on storage, so the
editor's file calls stay as fast and synchronous as natively. `/tmp`
and the type files E8 writes beside `init.ts` are not kept.
`?fresh` in the address forgets every file kept.

The `memory-fs` feature makes a native build use the tree too, which
`crates/e8-script/tests/all/memory_fs.rs` tests with:

```bash
cargo nextest run -p e8-script --features memory-fs memory_fs
```

This layer suits files that fit in memory. A folder on disk picked with
the File System Access API, or a remote one such as Dropbox, would need
the editor's worker to block while another thread does the browser's
asynchronous work, and file name handlers for remote names, as TRAMP's.

From localhost the editor is up about two seconds after the page loads.
The module is 32 MB, 5 MB with brotli; 4.5 MB of that is the names
section, which `wasm-opt` or `--strip-debug` would drop.

## What it cannot do yet

- **Your computer's files**: those in the page are only the browser's.
  There are no symbolic or hard links, and no trash: deleting is final.
- **Processes, the agent, the system clipboard**: none, gated off.
- **Browser keys**: `C-w`, `C-n` and `C-t` belong to the browser. Alt
  works as Meta.
- **Fonts**: egui's built-in ones; Geist Mono and Inter would need to be
  shipped with the page.

## How it is built, and what is fragile

- **The worker.** `Driver::spawn` starts its thread through a spawner the
  web crate sets (`e8_core::driver::set_spawner`), which starts a module
  worker running `worker.js`. The worker instantiates the same module with
  the shared memory and runs the editor's loop, which never returns.
- **The main thread never waits.** The browser forbids it, and a contended
  `Mutex` waits. The driver's quit flag is now made before the thread
  starts, rather than sent back from it, on every platform. The window
  takes what the editor published with `try_lock` on the web, and is woken
  by a message from the worker rather than through egui's context, whose
  lock it might find taken. Other locks the two threads share (smooth
  scrolling, the mouse) still use `lock`; they are held briefly, but a
  clash would trap.
- **Clocks.** std's `Instant::now` and `SystemTime::now` panic on the web,
  so the editor reads them from `e8_core::clock` (the `web-time` crate,
  which is std's clock natively), as it does `temp_dir` and the process id.
  std's channels cannot time out there either, so the command loop polls
  for input every few milliseconds on the web.
- **Two libcs.** tree-sitter compiles in a small libc of its own for wasm,
  and rquickjs links the wasi-libc it vendors: the same functions twice,
  which the linker is told to allow. That wasi-libc is built without
  atomics, which shared memory otherwise refuses (`--no-check-features`).
  Only the worker runs C, so its `malloc` never runs on two threads at
  once. A real build would build one libc, with atomics.
- **Absolute paths.** std says no path is absolute on this target, as it
  is not Unix, so the editor asks `vfs::is_absolute` instead.
- **Alt chords.** In a browser egui gives a key's text before its key
  event rather than after, so `keys.rs` takes back text that comes just
  before an Alt chord, on the web only.
