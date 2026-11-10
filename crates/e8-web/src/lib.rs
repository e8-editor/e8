//! E8 in a browser, a spike: the egui front end draws on a canvas on the
//! page's main thread, and the editor runs on a Web Worker that shares the
//! WebAssembly memory, as the native GUI runs it on a thread of its own
//! (ADR 0051). The worker may block, so prompts run their nested command
//! loops there as they do natively (ADR 0053); the main thread may not, so
//! it never waits on the editor. Scripts run on QuickJS. Files are e8-core's
//! tree in memory (`vfs`), kept in the browser's storage by storage.js.
//! There are no processes, agent or system clipboard yet.

#![cfg(target_arch = "wasm32")]

use std::cell::{Cell, RefCell};
use std::time::Duration;

use e8_core::vfs::{self, Change};
use e8_core::clock::Instant;
use e8_core::{Arg, Key, KeyCode};
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
    /// Keys the page sent, for the window to type at its next frame. Main
    /// thread only.
    static KEYS: RefCell<Vec<Key>> = const { RefCell::new(Vec::new()) };
    /// Whether the page's own text field has the focus, which the window
    /// then counts as its own.
    static TYPING: Cell<bool> = const { Cell::new(false) };
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
                    // What the echo area first says, as Emacs's startup
                    // message, rather than what loading the configuration
                    // last said.
                    editor.message("Welcome to E8. M-x runs any command.");
                    scripting
                });
                Ok(Box::new(Web(app, Touch::default())))
            }),
        )
        .await
}

/// The window, with the keys the page sends: on a touch screen the page
/// has keys of its own (touchkeys.js), and its own text field for the
/// phone's keyboard, as egui's would come up only for text egui edits.
struct Web(e8_gui::E8App, Touch);

impl eframe::App for Web {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        for key in KEYS.take() {
            self.0.key(key);
        }
        self.0.ui(ui, frame);
    }

    fn raw_input_hook(&mut self, ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        // So the cursor is drawn as in a focused window while the page's
        // field takes the typing.
        if TYPING.get() {
            raw_input.focused = true;
        }
        self.1.translate(ctx, raw_input);
    }
}

/// How far a finger moves before it is a drag rather than a tap, in points.
const TAP_SLOP: f32 = 10.0;
/// How long a finger rests before a drag selects rather than scrolls.
const HOLD: Duration = Duration::from_millis(450);
/// How much of a fling's speed is kept each second, and the speed in
/// points a second below which it stops.
const FLING_KEEP: f32 = 0.06;
const FLING_STOP: f32 = 40.0;

/// A finger on the canvas, as a touch screen is used: a drag scrolls, with
/// the momentum a flick gives it, a tap clicks where the finger came down,
/// and a drag after resting selects, as the mouse's drag does. egui gives a
/// finger as the mouse's button, so a drag would select rather than scroll.
/// A mouse is left as it is: its events come without touches. (The page
/// keeps a finger's pointer events from egui, which made a second press of
/// each tap: touchkeys.js's fingersAsTouches.)
#[derive(Default)]
struct Touch {
    finger: Option<Finger>,
    /// A fling's speed, in points a second, and when it last moved.
    fling: Option<(f32, Instant)>,
}

struct Finger {
    start: egui::Pos2,
    last: egui::Pos2,
    down: Instant,
    mode: Gesture,
    /// The speed of the last moves, for a fling.
    speed: f32,
    moved: Instant,
}

#[derive(PartialEq)]
enum Gesture {
    Undecided,
    Scrolling,
    Selecting,
}

impl Touch {
    fn translate(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        // A finger has no modifier keys.
        let modifiers = egui::Modifiers::NONE;
        let touched = raw.events.iter().any(|e| matches!(e, egui::Event::Touch { .. }));
        if !touched && self.finger.is_none() && self.fling.is_none() {
            return;
        }
        let button = |pos, pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers };
        let wheel = |dy: f32| egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: egui::vec2(0.0, dy),
            phase: egui::TouchPhase::Move,
            source: egui::MouseWheelSource::Unknown,
            modifiers,
        };
        let mut out = Vec::with_capacity(raw.events.len());
        for event in std::mem::take(&mut raw.events) {
            match event {
                // The button egui makes of a finger; this makes its own.
                egui::Event::PointerButton { .. } if touched || self.finger.is_some() => {}
                egui::Event::Touch { phase: egui::TouchPhase::Start, pos, .. } => {
                    self.fling = None;
                    if self.finger.is_none() {
                        let now = Instant::now();
                        self.finger = Some(Finger { start: pos, last: pos, down: now, mode: Gesture::Undecided, speed: 0.0, moved: now });
                    }
                }
                egui::Event::Touch { phase: egui::TouchPhase::Move, pos, .. } => {
                    let Some(f) = &mut self.finger else { continue };
                    if f.mode == Gesture::Undecided && (pos - f.start).length() > TAP_SLOP {
                        if f.down.elapsed() >= HOLD {
                            f.mode = Gesture::Selecting;
                            out.push(egui::Event::PointerMoved(f.start));
                            out.push(button(f.start, true));
                        } else {
                            f.mode = Gesture::Scrolling;
                            f.last = f.start;
                        }
                    }
                    match f.mode {
                        Gesture::Scrolling => {
                            let dy = pos.y - f.last.y;
                            let dt = f.moved.elapsed().as_secs_f32().max(0.001);
                            f.speed = 0.5 * f.speed + 0.5 * dy / dt;
                            f.moved = Instant::now();
                            out.push(wheel(dy));
                        }
                        Gesture::Selecting => out.push(egui::Event::PointerMoved(pos)),
                        Gesture::Undecided => {}
                    }
                    f.last = pos;
                }
                egui::Event::Touch { phase: egui::TouchPhase::End | egui::TouchPhase::Cancel, .. } => {
                    let Some(f) = self.finger.take() else { continue };
                    match f.mode {
                        Gesture::Undecided => {
                            out.push(egui::Event::PointerMoved(f.start));
                            out.push(button(f.start, true));
                            out.push(button(f.start, false));
                        }
                        Gesture::Selecting => out.push(button(f.last, false)),
                        // A finger that stopped before lifting does not fling.
                        Gesture::Scrolling if f.moved.elapsed() < Duration::from_millis(80) && f.speed.abs() > FLING_STOP => {
                            self.fling = Some((f.speed, Instant::now()));
                        }
                        Gesture::Scrolling => {}
                    }
                }
                event => out.push(event),
            }
        }
        if let Some((speed, at)) = self.fling {
            let dt = at.elapsed().as_secs_f32();
            let speed = speed * FLING_KEEP.powf(dt);
            if speed.abs() < FLING_STOP {
                self.fling = None;
            } else {
                out.push(wheel(speed * dt));
                self.fling = Some((speed, Instant::now()));
                ctx.request_repaint();
            }
        }
        raw.events = out;
    }
}

/// Types a key the page sent: `key` as the DOM names it (`Escape`, `Tab`,
/// `ArrowUp`, `Enter`, `Backspace`, or the character), with Control and
/// Meta (Alt) as `ctrl` and `meta`. A letter in a chord typed with Shift
/// keeps Shift, as Emacs writes C-S-f. Keys E8 has no name for are dropped.
#[wasm_bindgen]
pub fn send_key(key: &str, ctrl: bool, meta: bool) {
    let code = match key {
        "Escape" => KeyCode::Esc,
        "Tab" => KeyCode::Tab,
        "Enter" => KeyCode::Enter,
        "Backspace" => KeyCode::Backspace,
        "Delete" => KeyCode::Delete,
        "ArrowLeft" => KeyCode::Left,
        "ArrowRight" => KeyCode::Right,
        "ArrowUp" => KeyCode::Up,
        "ArrowDown" => KeyCode::Down,
        "Home" => KeyCode::Home,
        "End" => KeyCode::End,
        "PageUp" => KeyCode::PageUp,
        "PageDown" => KeyCode::PageDown,
        _ => {
            let mut chars = key.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => KeyCode::Char(c),
                _ => return,
            }
        }
    };
    let key = match code {
        KeyCode::Char(c) if (ctrl || meta) && c.is_ascii_uppercase() => Key { code: KeyCode::Char(c.to_ascii_lowercase()), ctrl, meta, shift: true },
        code => Key { code, ctrl, meta, shift: false },
    };
    KEYS.with_borrow_mut(|keys| keys.push(key));
    repaint();
}

/// Types text the page's field took from a phone's keyboard, a newline as
/// RET.
#[wasm_bindgen]
pub fn send_text(text: &str) {
    KEYS.with_borrow_mut(|keys| keys.extend(text.chars().map(|c| if c == '\n' { Key::new(KeyCode::Enter) } else { Key::char(c) })));
    repaint();
}

/// Tells the window whether the page's text field has the focus.
#[wasm_bindgen]
pub fn set_typing(on: bool) {
    TYPING.set(on);
    repaint();
}

/// Asks the window for a frame. Main thread only.
fn repaint() {
    CONTEXT.with_borrow(|c| {
        if let Some(c) = c {
            c.request_repaint();
        }
    });
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
            repaint();
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

/// Files to try things in, on a first visit: once the home directory holds
/// anything but the configuration the page puts in ~/.config each time,
/// what is there is the person's.
fn seed() {
    let home = std::path::Path::new(vfs::HOME);
    let first = vfs::read_dir(home).map_or(true, |entries| entries.flatten().all(|e| e.file_name() == ".config"));
    if !first {
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
