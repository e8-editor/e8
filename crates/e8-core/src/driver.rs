//! The editor on a thread of its own: step 3 of docs/multithreading.md.
//!
//! A [`Driver`] starts a thread, makes the editor there (it never leaves
//! it, as everything in it is single-threaded by design), and runs the
//! command loop: it takes input from one channel, keys in the order they
//! were typed, and once nothing more is waiting, redisplays and publishes
//! what each frame shows for the front end to draw. The front end never
//! waits on the editor: it sends input and draws the latest description,
//! whatever the editor is doing, so a long command no longer freezes the
//! window, and `C-g` reaches it through the quit flag.
//!
//! Anything else a front end, a test or the agent needs from the editor
//! goes as a closure to run on its thread ([`Input::Run`]), in turn with
//! the keys; [`Driver::with`] waits for one's answer.
//!
//! The loop also runs inside commands, as Emacs's does inside
//! read-from-minibuffer: a prompt waits for its answer with
//! [`Editor::wait_until`], which takes input from the same channel, one
//! at a time, until the answer comes (step 5, ADR 0053).

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::panic::AssertUnwindSafe;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError, channel};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::clock::Instant;

use crate::Result;
use crate::editor::Editor;
use crate::frame_description::FrameDescription;
use crate::key::{Key, KeyCode};
use crate::quit::QuitHandle;

/// Code a front end sends to run with the editor and what its setup kept.
pub type Job = Box<dyn FnOnce(&mut Editor, &dyn Any) + Send>;

/// What the editor's thread takes, in order.
pub enum Input {
    /// A key typed.
    Key(Key),
    /// `C-g`, which the front end also sent as a request to quit, with how
    /// many quits had stopped code when it was pressed: it runs as a key
    /// only if no command took the quit, as Emacs reads the quit character once.
    Quit(u32),
    /// Code to run with the editor, as a mouse event, a resize, a test's
    /// question or the agent's request, given what the setup kept alive,
    /// such as the script runtime.
    Run(Job),
    /// Something to take in, as a process's output, before redisplaying.
    Wake,
    /// The front end is closing.
    Close,
}

/// What the editor's thread last published.
#[derive(Default)]
pub struct Published {
    /// Counts publications, so a front end knows when there is a new one.
    pub generation: u64,
    /// What each frame shows, as the front end's `describe` gave it.
    pub frames: Vec<FrameDescription>,
    /// Whether the bell rang since the front end last looked.
    pub bell: bool,
    /// Whether it rings as a flash, as `visible-bell` says.
    pub visible_bell: bool,
    /// Whether the editor wants to exit, as `C-x C-c` does.
    pub exit: bool,
    /// How many times the editor asked to be suspended, as `suspend-emacs`
    /// does: a terminal stops the process each time it goes up.
    pub suspends: u64,
}

/// A handle on the editor's thread.
pub struct Driver {
    input: Sender<Input>,
    quit: QuitHandle,
    published: Arc<Mutex<Published>>,
    thread: Option<JoinHandle<()>>,
    /// How many inputs this handle has sent.
    sent: AtomicU64,
    idle: Arc<Idle>,
}

/// How many inputs the loop has taken, and whether it is waiting for the
/// next, at whatever depth of prompt, for callers that wait until it has
/// settled.
#[derive(Default)]
struct Idle {
    state: Mutex<(u64, bool)>,
    changed: Condvar,
}

impl Idle {
    fn set(&self, f: impl FnOnce(&mut (u64, bool))) {
        f(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()));
        self.changed.notify_all();
    }
}

/// How a web build starts the editor's thread: std cannot start threads
/// in a browser, so the front end starts a worker that shares the memory.
#[cfg(target_arch = "wasm32")]
pub type Spawner = fn(Box<dyn FnOnce() + Send>);

#[cfg(target_arch = "wasm32")]
static SPAWNER: std::sync::OnceLock<Spawner> = std::sync::OnceLock::new();

/// Sets how a web build starts the editor's thread, before the first
/// [`Driver::spawn`].
#[cfg(target_arch = "wasm32")]
pub fn set_spawner(spawn: Spawner) {
    let _ = SPAWNER.set(spawn);
}

/// How big the editor thread's stack is: Lisp-like code recurses deeply,
/// and spawned threads get 2 MB by default on macOS, a quarter of the main
/// thread's.
#[cfg(not(target_arch = "wasm32"))]
const STACK: usize = 64 << 20;

impl Driver {
    /// Starts the editor's thread. `setup` makes the editor ready there,
    /// loading scripts, and returns what must live as long as the editor,
    /// as the script runtime; it runs in the command loop, so a question it
    /// asks waits for the front end's keys, and `Input::Run` meanwhile sees
    /// nothing kept yet. `describe` lays the frames out and describes
    /// them after redisplay, as the front end draws them. `wake` tells the
    /// front end there is something new to draw.
    pub fn spawn(
        setup: impl FnOnce(&mut Editor) -> Box<dyn Any> + Send + 'static,
        describe: impl FnMut(&mut Editor) -> Vec<FrameDescription> + Send + 'static,
        wake: impl Fn() + Send + 'static,
    ) -> Driver {
        let (input, rx) = channel();
        let published = Arc::new(Mutex::new(Published::default()));
        // The quit flag is made here and given to the editor, rather than
        // sent back once the thread has made the editor: a browser's main
        // thread may not wait, and a worker starts only once it has returned.
        let quitting = Arc::new(crate::quit::QuitState::default());
        let quit = crate::quit::QuitHandle::new(quitting.clone());
        let shared = published.clone();
        let idle = Arc::new(Idle::default());
        let loop_idle = idle.clone();
        let waker = input.clone();
        let body = move || {
            let mut ed = Editor::new();
            ed.quitting = quitting;
            // Process output wakes the loop, rather than waiting for its next timer.
            let waker = Mutex::new(waker);
            ed.set_process_waker(Arc::new(move || {
                let _ = waker.lock().unwrap_or_else(|e| e.into_inner()).send(Input::Wake);
            }));
            run(ed, setup, rx, describe, wake, shared, loop_idle);
        };
        #[cfg(not(target_arch = "wasm32"))]
        let thread = Some(std::thread::Builder::new().name("editor".into()).stack_size(STACK).spawn(body).expect("the editor's thread starts"));
        #[cfg(target_arch = "wasm32")]
        let thread = {
            let spawn = SPAWNER.get().expect("a web build sets a spawner before starting the editor");
            spawn(Box::new(body));
            None
        };
        Driver { input, quit, published, thread, sent: AtomicU64::new(0), idle }
    }

    /// Sends input to the editor's thread.
    pub fn send(&self, input: Input) {
        self.sent.fetch_add(1, Ordering::SeqCst);
        let _ = self.input.send(input);
    }

    /// Types keys, as `C-x C-f`, and waits until the editor has taken them
    /// and waits for more: done, or waiting in a prompt they opened.
    pub fn press(&self, keys: &str) {
        let keys = keys.to_string();
        self.run(move |ed| {
            let _ = ed.press(&keys);
        });
        self.settle();
    }

    /// Types text, a newline as RET, as [`Driver::press`] waits.
    pub fn type_text(&self, text: &str) {
        let text = text.to_string();
        self.run(move |ed| ed.type_text(&text));
        self.settle();
    }

    /// Waits until the editor has taken everything sent and waits for
    /// input, at whatever depth of prompt, as tests do between keys.
    pub fn settle(&self) {
        let seq = self.sent.load(Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(30);
        let mut state = self.idle.state.lock().unwrap_or_else(|e| e.into_inner());
        while !(state.0 >= seq && state.1) {
            let left = until.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "the editor did not settle");
            state = self.idle.changed.wait_timeout(state, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    /// Sends a typed key. `C-g` also asks the editor to quit, so it stops
    /// a command that is running, as Emacs's quit character does.
    pub fn key(&self, key: Key) {
        if key.ctrl && !key.meta && key.code == KeyCode::Char('g') {
            let taken = self.quit.request();
            self.send(Input::Quit(taken));
        } else {
            self.send(Input::Key(key));
        }
    }

    /// Runs `f` with the editor on its thread, after the input sent before
    /// it, and waits for its answer.
    pub fn with<T: Send + 'static>(&self, f: impl FnOnce(&mut Editor) -> T + Send + 'static) -> T {
        let (tx, rx) = channel();
        self.run(move |ed| {
            let _ = tx.send(f(ed));
        });
        rx.recv().expect("the editor's thread answers")
    }

    /// Runs `f` with the editor on its thread, after the input sent before
    /// it, without waiting.
    pub fn run(&self, f: impl FnOnce(&mut Editor) + Send + 'static) {
        self.send(Input::Run(Box::new(move |ed, _| f(ed))));
    }

    /// What the editor last published.
    pub fn published(&self) -> std::sync::MutexGuard<'_, Published> {
        self.published.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// What the editor last published, unless its thread is publishing
    /// now, for a browser's main thread, which may not wait.
    pub fn try_published(&self) -> Option<std::sync::MutexGuard<'_, Published>> {
        match self.published.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(e)) => Some(e.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }

    /// The editor's quit flag, which `C-g` sets.
    pub fn quit_handle(&self) -> &QuitHandle {
        &self.quit
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.send(Input::Close);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A command loop code can run again from inside a command until a
/// condition holds, as a prompt waits for its answer.
pub trait NestedLoop {
    /// Takes input until `done` says, or fails with `quit` when the editor closes.
    fn wait(&self, ed: &mut Editor, done: &dyn Fn(&Editor) -> bool) -> Result<()>;

    /// Shows the frames as they are now, in the middle of running code, as
    /// Emacs's `redisplay` function does.
    fn show(&self, ed: &mut Editor);

    /// Shows a message just put in the echo area while code runs, as
    /// Emacs's `message` redisplays the echo area at once, so a long
    /// command, or init.ts installing packages, says what it is doing.
    /// Code that has run only briefly shows it when it finishes, as usual.
    fn message_shown(&self, ed: &mut Editor);
}

/// Waits up to `timeout` for input, as `Receiver::recv_timeout`. On the web
/// std's channels cannot time out, as they read std's clock, which panics
/// there; the editor's worker polls instead, sleeping a few milliseconds at
/// a time, as std's sleep needs no clock.
fn recv_timeout(rx: &Receiver<Input>, timeout: Duration) -> std::result::Result<Input, RecvTimeoutError> {
    #[cfg(not(target_arch = "wasm32"))]
    return rx.recv_timeout(timeout);
    #[cfg(target_arch = "wasm32")]
    {
        let until = Instant::now().checked_add(timeout);
        loop {
            match rx.try_recv() {
                Ok(input) => return Ok(input),
                Err(TryRecvError::Disconnected) => return Err(RecvTimeoutError::Disconnected),
                Err(TryRecvError::Empty) => {}
            }
            let left = until.map_or(Duration::MAX, |until| until.saturating_duration_since(Instant::now()));
            if left.is_zero() {
                return Err(RecvTimeoutError::Timeout);
            }
            std::thread::sleep(left.min(Duration::from_millis(4)));
        }
    }
}

/// How long code runs before a message it shows is drawn at once.
const SHOW_MESSAGES_AFTER: Duration = Duration::from_millis(100);
/// How often messages shown in a row are drawn, at most.
const SHOW_MESSAGES_EVERY: Duration = Duration::from_millis(50);

/// The editor thread's command loop: input in order, timers when due, and
/// a redisplay and publication once nothing waits, as Emacs redisplays
/// only when no input is pending.
struct CommandLoop<D> {
    rx: Receiver<Input>,
    /// What setup kept, once it is done; nothing while it runs.
    keep: RefCell<Box<dyn Any>>,
    describe: RefCell<D>,
    wake: Box<dyn Fn()>,
    published: Arc<Mutex<Published>>,
    closing: Cell<bool>,
    idle: Arc<Idle>,
    /// When the loop last stopped waiting for input and started running code.
    busy_since: Cell<Instant>,
    /// When frames were last published.
    published_at: Cell<Instant>,
}

impl<D: FnMut(&mut Editor) -> Vec<FrameDescription>> CommandLoop<D> {
    /// Redisplays and publishes what each frame shows, and tells the front end.
    fn publish(&self, ed: &mut Editor) {
        self.published_at.set(Instant::now());
        // A describe that panics, or that publishes again from inside
        // itself, leaves the frames last published rather than none.
        let frames = self
            .describe
            .try_borrow_mut()
            .ok()
            .and_then(|mut describe| std::panic::catch_unwind(AssertUnwindSafe(|| describe(ed))).ok());
        {
            let mut p = self.published.lock().unwrap_or_else(|e| e.into_inner());
            p.generation += 1;
            if let Some(frames) = frames {
                p.frames = frames;
            }
            p.bell |= ed.take_bell();
            p.visible_bell = ed.variable("visible-bell").is_some_and(|v| v.is_true());
            p.exit = ed.should_quit();
            p.suspends = ed.suspend_requests();
        }
        (self.wake)();
    }

    /// Handles one input; false when the front end is closing.
    fn handle(&self, ed: &mut Editor, input: Input) -> bool {
        match input {
            Input::Key(key) => guarded(ed, |ed| ed.handle_key(key)),
            // Taken by a command it stopped, or still waiting to be read.
            // Unless a quit stopped code since this C-g was pressed, which
            // was this C-g answered, it is a key: the flag alone cannot say,
            // as each command starts by clearing it, so a key queued before
            // the C-g would lose it.
            Input::Quit(taken) => {
                if ed.quit_state().taken() == taken {
                    ed.quit_state().clear();
                    guarded(ed, |ed| ed.handle_key(Key { code: KeyCode::Char('g'), ctrl: true, meta: false, shift: false }));
                }
            }
            Input::Run(f) => guarded(ed, |ed| f(ed, &**self.keep.borrow())),
            Input::Wake => {}
            Input::Close => return false,
        }
        true
    }
}

impl<D: FnMut(&mut Editor) -> Vec<FrameDescription>> NestedLoop for CommandLoop<D> {
    fn show(&self, ed: &mut Editor) {
        self.publish(ed);
    }

    fn message_shown(&self, ed: &mut Editor) {
        if self.busy_since.get().elapsed() >= SHOW_MESSAGES_AFTER && self.published_at.get().elapsed() >= SHOW_MESSAGES_EVERY {
            self.publish(ed);
        }
    }

    fn wait(&self, ed: &mut Editor, done: &dyn Fn(&Editor) -> bool) -> Result<()> {
        loop {
            if done(ed) {
                return Ok(());
            }
            if self.closing.get() || ed.should_quit() {
                return Err(crate::quit::quit_error());
            }
            // Keys typed ahead first, then input one at a time, so what
            // comes after an answer waits for the command that asked, as in Emacs.
            if let Some(key) = ed.next_typed_ahead() {
                guarded(ed, |ed| ed.handle_key(key));
                continue;
            }
            let input = match self.rx.try_recv() {
                Ok(input) => {
                    self.idle.set(|s| s.0 += counted(&input));
                    input
                }
                Err(TryRecvError::Disconnected) => {
                    self.closing.set(true);
                    continue;
                }
                Err(TryRecvError::Empty) => {
                    // Nothing waiting: timers, then show where things are, then wait.
                    guarded(ed, |ed| ed.run_timers_awaiting_input());
                    if done(ed) {
                        return Ok(());
                    }
                    self.publish(ed);
                    let timeout = ed.next_timer_in().unwrap_or(Duration::from_secs(3600));
                    self.idle.set(|s| s.1 = true);
                    let input = recv_timeout(&self.rx, timeout);
                    self.busy_since.set(Instant::now());
                    self.idle.set(|s| {
                        s.1 = false;
                        s.0 += input.as_ref().map_or(0, counted);
                    });
                    match input {
                        Ok(input) => input,
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => {
                            self.closing.set(true);
                            continue;
                        }
                    }
                }
            };
            if !self.handle(ed, input) {
                self.closing.set(true);
            }
        }
    }
}

/// How many of the inputs [`Driver::send`] counts this is: a process's
/// wake is sent by the process, so counting it would let
/// [`Driver::settle`] return before the input it waits for ran.
fn counted(input: &Input) -> u64 {
    !matches!(input, Input::Wake) as u64
}

/// Runs the command loop until the editor exits or the front end closes.
fn run(
    mut ed: Editor,
    setup: impl FnOnce(&mut Editor) -> Box<dyn Any>,
    rx: Receiver<Input>,
    describe: impl FnMut(&mut Editor) -> Vec<FrameDescription> + 'static,
    wake: impl Fn() + 'static,
    published: Arc<Mutex<Published>>,
    idle: Arc<Idle>,
) {
    let command_loop = Rc::new(CommandLoop {
        rx,
        keep: RefCell::new(Box::new(())),
        describe: RefCell::new(describe),
        wake: Box::new(wake),
        published,
        closing: Cell::new(false),
        idle,
        busy_since: Cell::new(Instant::now()),
        published_at: Cell::new(Instant::now()),
    });
    ed.command_loop = Some(command_loop.clone());
    // Setup runs with the loop there, so what init.ts and the startup hooks
    // ask, as desktop's question about a locked desktop, waits for an
    // answer while the window draws, as Emacs's startup asks in the
    // minibuffer.
    let kept = setup(&mut ed);
    *command_loop.keep.borrow_mut() = kept;
    let _ = command_loop.wait(&mut ed, &|ed| ed.should_quit());
    command_loop.publish(&mut ed);
    // The loop holds what setup kept, as the script runtime, which goes
    // before the editor it was made for.
    ed.command_loop = None;
    drop(command_loop);
}

/// Runs editor code so a panic in it reports in the echo area and the
/// loop goes on, as Emacs carries on after an error.
fn guarded(ed: &mut Editor, f: impl FnOnce(&mut Editor)) {
    let state = ed.loop_state();
    if let Err(panic) = std::panic::catch_unwind(AssertUnwindSafe(|| f(ed))) {
        ed.restore_loop_state(state);
        let what = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
        ed.message(format!("Internal error: {what}"));
    }
}
