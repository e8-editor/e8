//! E8 in a browser, a spike: the egui front end draws on a canvas on the
//! page's main thread, and the editor runs on a Web Worker that shares the
//! WebAssembly memory, as the native GUI runs it on a thread of its own
//! (ADR 0051). The worker may block, so prompts run their nested command
//! loops there as they do natively (ADR 0053); the main thread may not, so
//! it never waits on the editor. Scripts run on QuickJS. There are no
//! files, processes, agent or system clipboard yet.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;

use e8_core::{Arg, Editor};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

thread_local! {
    /// The window's egui context, which the editor's worker wakes by a
    /// message when it has something new to draw. Main thread only.
    static CONTEXT: RefCell<Option<egui::Context>> = const { RefCell::new(None) };
    /// The workers started, kept so they are not collected.
    static WORKERS: RefCell<Vec<web_sys::Worker>> = const { RefCell::new(Vec::new()) };
}

/// How big the editor worker's stack is, in the shared memory. Natively it
/// is 64 MB; QuickJS and the regexp matcher recurse.
const WORKER_STACK: u32 = 32 << 20;

/// Starts E8 on `canvas`. The page calls this once the module has loaded.
#[wasm_bindgen]
pub async fn start(canvas: web_sys::HtmlCanvasElement) -> Result<(), JsValue> {
    std::panic::set_hook(Box::new(|info| web_sys::console::error_1(&info.to_string().into())));
    e8_core::driver::set_spawner(spawn_worker);
    let runner: &'static eframe::WebRunner = Box::leak(Box::new(eframe::WebRunner::new()));
    runner
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(|cc| {
                e8_gui::theme::install_fonts(&cc.egui_ctx, false);
                CONTEXT.with_borrow_mut(|c| *c = Some(cc.egui_ctx.clone()));
                let app = e8_gui::E8App::threaded_waking(&cc.egui_ctx, wake, |editor| {
                    let scripting = e8_script::config::setup(editor, false);
                    seed(editor);
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
    let onmessage = Closure::<dyn Fn(web_sys::MessageEvent)>::new(|_| {
        CONTEXT.with_borrow(|c| {
            if let Some(c) = c {
                c.request_repaint();
            }
        });
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

/// Buffers to try things in. There are no files: these are buffers only.
fn seed(editor: &mut Editor) {
    let mut make = |name: &str, mode: &str, text: &str| {
        let _ = editor.call("switch-to-buffer", vec![Arg::Str(name.into())]);
        let _ = editor.insert(text);
        let _ = editor.call(mode, vec![]);
        let _ = editor.call("beginning-of-buffer", vec![]);
        let _ = editor.call("not-modified", vec![]);
    };
    make(
        "example.py",
        "python-ts-mode",
        "def fib(n):\n    \"\"\"The nth Fibonacci number.\"\"\"\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\n\nprint([fib(n) for n in range(10)])\n",
    );
    make("welcome.org", "org-mode", WELCOME);
}
