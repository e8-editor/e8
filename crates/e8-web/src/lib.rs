//! E8 in a browser, a spike: the egui front end draws on a canvas on the
//! page's main thread, and the editor runs on a Web Worker that shares the
//! WebAssembly memory, as the native GUI runs it on a thread of its own
//! (ADR 0051). The worker may block, so prompts run their nested command
//! loops there as they do natively (ADR 0053); the main thread may not, so
//! it never waits on the editor. Scripts run on QuickJS. Files are e8-core's
//! tree in memory (`vfs`), kept in the browser's storage by storage.js.
//! There are no processes, agent or system clipboard yet.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;

use e8_core::vfs::{self, Change};
use e8_core::Arg;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

thread_local! {
    /// The window's egui context, which the editor's worker wakes by a
    /// message when it has something new to draw. Main thread only.
    static CONTEXT: RefCell<Option<egui::Context>> = const { RefCell::new(None) };
    /// The workers started, kept so they are not collected.
    static WORKERS: RefCell<Vec<web_sys::Worker>> = const { RefCell::new(Vec::new()) };
    /// storage.js's `change`, which keeps a change to the files. Main thread only.
    static STORE: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// How big the editor worker's stack is, in the shared memory. Natively it
/// is 64 MB; QuickJS and the regexp matcher recurse.
const WORKER_STACK: u32 = 32 << 20;

/// Starts E8 on `canvas`, with the files storage.js kept, as `[path,
/// bytes]` with directories as `[path + "/", null]`, and its `change`
/// function to keep each change. The page calls this once the module has
/// loaded.
#[wasm_bindgen]
pub async fn start(canvas: web_sys::HtmlCanvasElement, files: js_sys::Array, store: js_sys::Function) -> Result<(), JsValue> {
    std::panic::set_hook(Box::new(|info| web_sys::console::error_1(&info.to_string().into())));
    e8_core::driver::set_spawner(spawn_worker);
    // The editor's worker has not started, so the tree is this thread's alone.
    vfs::restore(files.iter().filter_map(|entry| {
        let entry: js_sys::Array = entry.dyn_into().ok()?;
        let path = entry.get(0).as_string()?;
        let data = entry.get(1).dyn_into::<js_sys::Uint8Array>().map(|a| a.to_vec()).unwrap_or_default();
        Some((path, data))
    }));
    STORE.with_borrow_mut(|s| *s = Some(store));
    vfs::watch(keep);
    let runner: &'static eframe::WebRunner = Box::leak(Box::new(eframe::WebRunner::new()));
    runner
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(|cc| {
                e8_gui::theme::install_fonts(&cc.egui_ctx, false);
                CONTEXT.with_borrow_mut(|c| *c = Some(cc.egui_ctx.clone()));
                let app = e8_gui::E8App::threaded_waking(&cc.egui_ctx, wake, |editor| {
                    seed();
                    let scripting = e8_script::config::setup(editor, true);
                    for file in ["example.py", "welcome.org"] {
                        let _ = editor.call("find-file", vec![Arg::Str(format!("{}/{file}", vfs::HOME))]);
                    }
                    scripting
                });
                Ok(Box::new(app))
            }),
        )
        .await
}

/// Runs on the editor's worker: tells the window there is something new to
/// draw, by a message the main thread answers with a repaint.
fn wake() {
    let scope: web_sys::DedicatedWorkerGlobalScope = js_sys::global().unchecked_into();
    let _ = scope.post_message(&JsValue::NULL);
}

/// Starts `body` on a module worker that shares this module's memory, as
/// the driver's thread. worker.js instantiates the module there and calls
/// [`worker_start`].
fn spawn_worker(body: Box<dyn FnOnce() + Send>) {
    let options = web_sys::WorkerOptions::new();
    options.set_type(web_sys::WorkerType::Module);
    let worker = web_sys::Worker::new_with_options("./worker.js", &options).expect("the editor's worker starts");
    // A message is a change to keep, or with no data a wake-up.
    let onmessage = Closure::<dyn Fn(web_sys::MessageEvent)>::new(|event: web_sys::MessageEvent| {
        let data = event.data();
        if data.is_null() {
            CONTEXT.with_borrow(|c| {
                if let Some(c) = c {
                    c.request_repaint();
                }
            });
        } else {
            STORE.with_borrow(|s| {
                if let Some(store) = s {
                    let _ = store.call1(&JsValue::NULL, &data);
                }
            });
        }
    });
    worker.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    onmessage.forget();
    let body = Box::into_raw(Box::new(body)) as usize as u32;
    let message = js_sys::Array::of4(&wasm_bindgen::module(), &wasm_bindgen::memory(), &JsValue::from(body), &JsValue::from(WORKER_STACK));
    worker.post_message(&message).expect("the worker takes its start");
    WORKERS.with_borrow_mut(|w| w.push(worker));
}

/// Runs on a worker: the body [`spawn_worker`] passed, which for the editor
/// never returns.
#[wasm_bindgen]
pub fn worker_start(body: u32) {
    // SAFETY: `body` is the box spawn_worker leaked for this worker alone.
    let body = unsafe { Box::from_raw(body as usize as *mut Box<dyn FnOnce() + Send>) };
    body();
}

/// The clock rquickjs's libc shim asks the host for, in microseconds since
/// the epoch, for `Date.now()` and QuickJS's timers. Defined here, the
/// linker never leaves it as an import.
#[unsafe(no_mangle)]
pub extern "C" fn __rquickjs_host_now_us() -> f64 {
    e8_core::clock::system_now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_micros() as f64)
}

const WELCOME: &str = include_str!("welcome.org");

/// Runs on the editor's worker: sends a change to the files to the page to
/// keep, unless it is to what is made again at each start, the temporary
/// directory and the type files E8 writes beside init.ts.
fn keep(change: Change) {
    let (op, path, data) = match change {
        Change::Write(path, data) => ("write", path, Some(data)),
        Change::MakeDir(path) => ("mkdir", path, None),
        Change::Remove(path) => ("remove", path, None),
    };
    let config = std::path::Path::new(vfs::HOME).join(".config/e8");
    if path.starts_with("/tmp") || path.starts_with(config.join("shipped")) || path == config.join("e8.d.ts") {
        return;
    }
    let message = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&message, &"op".into(), &op.into());
    let _ = js_sys::Reflect::set(&message, &"path".into(), &path.display().to_string().into());
    if let Some(data) = data {
        // A copy, out of the shared memory, which postMessage would share.
        let _ = js_sys::Reflect::set(&message, &"data".into(), &js_sys::Uint8Array::from(data).into());
    }
    let scope: web_sys::DedicatedWorkerGlobalScope = js_sys::global().unchecked_into();
    let _ = scope.post_message(&message);
}

/// Files to try things in, on a first visit: once the home directory
/// exists, what is there is the person's.
fn seed() {
    let home = std::path::Path::new(vfs::HOME);
    if vfs::path_exists(home) {
        return;
    }
    let files: [(&str, &str); 4] = [
        ("welcome.org", WELCOME),
        ("example.py", EXAMPLE_PY),
        ("notes/ideas.org", "* Ideas\n** TODO Write something here, then save it with C-x C-s\n"),
        ("scripts/hello.ts", HELLO_TS),
    ];
    for (name, text) in files {
        let path = home.join(name);
        if let Some(dir) = path.parent() {
            let _ = vfs::create_dir_all(dir);
        }
        let _ = vfs::write(&path, text);
    }
}

const EXAMPLE_PY: &str = "def fib(n):\n    \"\"\"The nth Fibonacci number.\"\"\"\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\n\nprint([fib(n) for n in range(10)])\n";

const HELLO_TS: &str = r#"// A command of your own: M-x load-file RET ~/scripts/hello.ts RET,
// then M-x hello.
e8.defineCommand({
  name: "hello",
  doc: "Say hello from a script.",
  run() {
    e8.message(`Hello from a script, in ${e8.bufferName()}`);
  },
});
"#;
