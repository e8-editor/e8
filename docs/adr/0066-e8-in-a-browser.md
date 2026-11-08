# 0066. E8 in a browser

Status: accepted · 2026-11-08

## Context

E8's front end is egui and its core is Rust, both of which compile to WebAssembly, so the editor itself could run in a web page: a demo above the fold of a website for E8, with only the packages that ship with it. [ADR 0054](0054-v8-as-the-script-engine.md) kept QuickJS for builds where V8 cannot go, naming the web.

A spike (`crates/e8-web`, whose README says what works) found what stands in the way:

- **Prompts block.** A prompt runs a command loop inside the command that asked ([ADR 0053](0053-prompts-that-return-their-answer.md)), waiting for keys. A browser's main thread may not wait, and the editor on the window's thread has no loop to run, so `M-x` would fail with `end-of-file`.
- **The script engine.** The `v8` crate does not build for wasm. QuickJS and tree-sitter are C, which needs a clang that targets wasm; rquickjs 0.14 and tree-sitter 0.27 each bring a small libc for `wasm32-unknown-unknown`.
- **std on the web** has no file system, and panics for the time, the temporary directory, the process id, and timeouts on its channels. It also says no path is absolute, the target not being Unix.

## Options considered

For the editor's thread:

1. **The editor on the window's thread**, prompts awaiting rather than blocking. Undoes ADR 0053, and would make the web build a different editor.
2. **The editor on a Web Worker that shares the wasm memory**, as [ADR 0051](0051-the-editor-thread.md) runs it on a thread of its own. A worker may block, so prompts work unchanged. Needs std built with atomics (nightly Rust), and pages served cross-origin isolated.

For scripts:

1. **QuickJS, compiled to wasm.** The engine `make check` already tests, with the same behaviour; interpreted, about 1 MB of wasm.
2. **The browser's own JavaScript engine**, as a third engine. Fast and small, but E8 runs promise jobs and resolves modules synchronously at points it chooses, which a browser allows only once the code running returns: packages would need rewriting on the way in (async functions as generators, imports as a module table), and three browsers' engines would need testing.

For files:

1. **A layer under the file primitives**: `std::fs` natively, a tree in memory on the web, kept in the browser's storage.
2. **WASI**, with a shim in the worker. Brings a second target and its own file system emulation, which still needs keeping somewhere.

## Decision

The web build runs the editor on a Web Worker sharing memory with the page, scripts on QuickJS, and files through `e8_core::vfs`, which natively is `std::fs` and on the web a tree in memory that the page fills from, and keeps in, the browser's Origin Private File System.

## Consequences

- Prompts, `M-x`, `M-:`, Org, tree-sitter, Dired, visiting and saving work in a page as in the app; files are in `/home/e8` and survive a reload.
- Code reaches files through `vfs` (`use crate::vfs as fs`), asks of paths with `vfs::path_exists`, `path_is_dir`, `path_is_file`, `path_is_symlink` and `is_absolute` rather than `Path`'s own methods, which read std's file system, and reads the time, the temporary directory and the process id from `e8_core::clock`. Natively these are std's own.
- The `memory-fs` feature uses the tree natively, which `tests/all/memory_fs.rs` tests; `make check` does not run it, nor build for the web.
- `Driver::spawn` makes the quit flag before starting its thread, on every platform, so the window's thread never waits for the editor; on the web it starts the thread through a spawner the front end sets, polls for input, and the window only tries the locks it shares.
- Building for the web needs nightly Rust with `rust-src`, `wasm-bindgen-cli` at the lockfile's version, and LLVM's clang (Apple's does not target wasm), which `build.sh` takes from Nix. Serving needs the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers, which also stop sign-in popups from reaching the page: try that before relying on one.
- Fragile, to revisit before the web build is more than a demo: the two libcs are linked with `--allow-multiple-definition`, and rquickjs's, built without atomics, with `--no-check-features`, safe only while all C runs on the worker; the locks for smooth scrolling and the mouse can still make the main thread wait; the module is 32 MB, 5 MB with brotli.
- Files elsewhere, a folder picked on disk or one in the cloud, would need the worker to block while another thread does the browser's asynchronous work, and file name handlers for remote names, as TRAMP's.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| `web-time` | 1 | The clock in e8-core: std's natively, the browser's on the web, where std's panics (already in the build through egui) |
| `wasm-bindgen`, `wasm-bindgen-futures`, `js-sys`, `web-sys` | 0.2.129, 0.4, 0.3 | e8-web's calls to the browser, built only for the web (already in the build through eframe) |
