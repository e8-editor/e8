//! The V8 engine, through the v8 crate (rusty_v8): the isolate, entering it
//! from the editor, packages as ES modules, converting values, and the
//! natives' binding.
//!
//! Scripts and the editor call each other to any depth: a script calls a
//! native, the native runs a command, the command is a script's. Each entry
//! from the editor opens a handle scope on the isolate, nested in whatever
//! scope the call it came from had open, as V8's handle scopes nest in C++.
//! The outermost entry arms a watchdog thread that asks the isolate to
//! check, every few milliseconds, whether the script must be stopped
//! ([`should_stop`]), and stops it with `TerminateExecution`, which runs no
//! `finally`, as QuickJS's interrupt does.

mod bindings;

pub(crate) use bindings::{Param, Ret};

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use e8_core::{Arg, Editor, Error, FaceAttrs, PrefixArg, Result, Value as EditorValue};

use crate::{
    EDITOR, Failure, Outermost, PRELUDE, Restore, editor_call, natives, nested_deadline, package_source, prepare_require, should_stop, strip_module_types,
    stripped, values,
};

/// A JavaScript exception is pending in the isolate: the native returns and
/// V8 throws it in the script that called.
pub(crate) struct Thrown;

pub(crate) type Js<'s> = std::result::Result<v8::Local<'s, v8::Value>, Thrown>;

static PLATFORM: OnceLock<v8::SharedRef<v8::Platform>> = OnceLock::new();

/// V8's platform, started once for the process.
fn platform() -> &'static v8::SharedRef<v8::Platform> {
    PLATFORM.get_or_init(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform.clone());
        v8::V8::initialize();
        platform
    })
}

thread_local! {
    /// The engines of the scripts running, innermost last.
    static ENGINES: RefCell<Vec<Rc<Inner>>> = const { RefCell::new(Vec::new()) };
    /// Promises rejected with no handler yet, and why: an async command's
    /// error, reported once the code that settled it has finished.
    static UNHANDLED: RefCell<Vec<(v8::Global<v8::Promise>, v8::Global<v8::Value>)>> = const { RefCell::new(Vec::new()) };
}

/// The engine running now.
fn current() -> Rc<Inner> {
    ENGINES.with_borrow(|e| e.last().cloned()).expect("a script is running")
}

/// An isolate with the `e8` global. Clones share it.
#[derive(Clone)]
pub(crate) struct Engine {
    inner: Rc<Inner>,
}

/// What an engine holds. Its handles are declared before the isolate, so
/// they are freed while it lives.
struct Inner {
    context: v8::Global<v8::Context>,
    /// The packages compiled, by file name.
    modules: RefCell<HashMap<String, v8::Global<v8::Module>>>,
    /// Editor functions given to scripts, by id, for the functions that call
    /// them, with how many of those the script still has: the prelude tells
    /// [`forget_function`] as each is collected.
    functions: RefCell<HashMap<u64, (e8_core::Function, usize)>>,
    watchdog: Watchdog,
    /// The isolate, which `owned` keeps at this address.
    isolate: NonNull<v8::Isolate>,
    _owned: Box<v8::OwnedIsolate>,
}

impl Engine {
    /// Starts an isolate, installs the natives and runs the prelude.
    pub(crate) fn new(ed: &mut Editor) -> Result<Engine> {
        platform();
        let mut owned = Box::new(v8::Isolate::new(v8::CreateParams::default()));
        owned.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        owned.set_promise_reject_callback(promise_rejected);
        owned.set_host_import_module_dynamically_callback(import_dynamically);
        let watchdog = Watchdog::start(owned.thread_safe_handle());
        let isolate = NonNull::from(&mut **owned);
        let context = {
            v8::scope!(let scope, &mut **owned);
            let context = v8::Context::new(scope, Default::default());
            v8::Global::new(scope, context)
        };
        let inner = Rc::new(Inner {
            context,
            modules: RefCell::new(HashMap::new()),
            functions: RefCell::new(HashMap::new()),
            watchdog,
            isolate,
            _owned: owned,
        });
        let engine = Engine { inner };
        enter(&engine.inner, ed, |scope| {
            install_native(scope);
            run_script(scope, "e8:prelude", PRELUDE).map(drop).map_err(Failure::into_error)
        })?;
        Ok(engine)
    }

    /// Imports a package, as an ES module, and what it imports.
    pub(crate) fn import(&self, ed: &mut Editor, name: &str) -> Result<()> {
        enter(&self.inner, ed, |scope| import(scope, name).map(drop).map_err(Failure::into_error_with_location))
    }

    /// Runs a script, its types already erased, as a global script.
    pub(crate) fn run(&self, ed: &mut Editor, filename: &str, js: String) -> Result<()> {
        enter(&self.inner, ed, |scope| run_script(scope, filename, &js).map(drop).map_err(Failure::into_error_with_location))
    }

    /// Evaluates an expression and gives its value as JSON, or `undefined`.
    pub(crate) fn eval_json(&self, ed: &mut Editor, js: String) -> Result<String> {
        enter(&self.inner, ed, |scope| {
            let value = run_script(scope, "expression", &js).map_err(Failure::into_error)?;
            if value.is_undefined() || value.is_function() || value.is_symbol() {
                return Ok("undefined".to_string());
            }
            v8::tc_scope!(let tc, scope);
            match v8::json::stringify(tc, value) {
                Some(json) => Ok(json.to_rust_string_lossy(tc)),
                None => Err(failure(tc).into_error()),
            }
        })
    }
}

/// Takes the engine off [`ENGINES`] when dropped.
struct Popped;

impl Drop for Popped {
    fn drop(&mut self) {
        ENGINES.with_borrow_mut(|e| e.pop());
    }
}

/// Runs `f` in the engine's context, giving natives access to `ed`.
fn enter<R>(inner: &Rc<Inner>, ed: &mut Editor, f: impl FnOnce(&mut v8::PinScope) -> Result<R>) -> Result<R> {
    let _editor = Restore::set(&EDITOR, Some(NonNull::from(ed)));
    let nested = ENGINES.with_borrow(|e| e.iter().any(|e| Rc::ptr_eq(e, inner)));
    ENGINES.with_borrow_mut(|e| e.push(inner.clone()));
    let _popped = Popped;
    // SAFETY: the isolate lives as long as `inner`, and is only used on this
    // thread; a nested entry's scope closes before the scope it is in.
    let isolate = unsafe { &mut *inner.isolate.as_ptr() };
    v8::scope!(let scope, isolate);
    let context = v8::Local::new(scope, &inner.context);
    let scope = &mut v8::ContextScope::new(scope, context);
    if nested {
        let _deadline = nested_deadline();
        let result = f(scope);
        // A prompt answered from code already running, as keys a macro
        // replays, lets its command carry on here, where Emacs's would,
        // rather than once all the code has finished. Rejections nothing
        // handles are reported by the outermost call.
        scope.perform_microtask_checkpoint();
        return result;
    }
    let outermost = Outermost::begin();
    let watch = inner.watchdog.arm();
    let result = f(scope);
    drop(watch);
    if scope.is_execution_terminating() {
        scope.cancel_terminate_execution();
    }
    outermost.unwind_if_stopped();
    // What waits on promises settled meanwhile runs now, before the editor
    // goes on: an async command awaiting a prompt carries on as soon as the
    // answer comes.
    scope.perform_microtask_checkpoint();
    // A FinalizationRegistry's cleanup is a task V8 posts to the platform.
    while v8::Platform::pump_message_loop(platform(), scope, false) {}
    let unhandled = UNHANDLED.take();
    match (result, unhandled.into_iter().next()) {
        (Ok(_), Some((_, reason))) => {
            let reason = v8::Local::new(scope, &reason);
            Err(failure_of(scope, reason).into_error())
        }
        (result, _) => result,
    }
}

/// Keeps rejected promises nothing handles, to report when the code that
/// rejected them has finished; forgets one a handler is added to.
unsafe extern "C" fn promise_rejected(message: v8::PromiseRejectMessage) {
    v8::callback_scope!(unsafe let scope, &message);
    let promise = message.get_promise();
    match message.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            let reason = message.get_value().unwrap_or_else(|| v8::undefined(scope).into());
            let entry = (v8::Global::new(scope, promise), v8::Global::new(scope, reason));
            UNHANDLED.with_borrow_mut(|u| u.push(entry));
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => {
            UNHANDLED.with_borrow_mut(|u| u.retain(|(p, _)| v8::Local::new(scope, p) != promise));
        }
        _ => {}
    }
}

/// Asks the isolate to check whether to stop while a script runs.
struct Watchdog {
    state: Arc<(Mutex<Watch>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
struct Watch {
    armed: bool,
    done: bool,
}

/// How often a running script is asked whether to stop.
const WATCH_EVERY: Duration = Duration::from_millis(10);

impl Watchdog {
    fn start(handle: v8::IsolateHandle) -> Watchdog {
        let state = Arc::new((Mutex::new(Watch::default()), Condvar::new()));
        let shared = state.clone();
        let thread = std::thread::Builder::new()
            .name("e8-v8-watchdog".into())
            .spawn(move || {
                let (lock, wake) = &*shared;
                let mut watch = lock.lock().unwrap();
                while !watch.done {
                    if watch.armed {
                        let (w, _) = wake.wait_timeout(watch, WATCH_EVERY).unwrap();
                        watch = w;
                        if watch.armed && !watch.done {
                            handle.request_interrupt(check_stop, std::ptr::null_mut());
                        }
                    } else {
                        watch = wake.wait(watch).unwrap();
                    }
                }
            })
            .expect("the watchdog thread starts");
        Watchdog { state, thread: Some(thread) }
    }

    fn arm(&self) -> Armed<'_> {
        self.set(true);
        Armed(self)
    }

    fn set(&self, armed: bool) {
        let (lock, wake) = &*self.state;
        lock.lock().unwrap().armed = armed;
        wake.notify_all();
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let (lock, wake) = &*self.state;
        lock.lock().unwrap().done = true;
        wake.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Disarms the watchdog when the outermost script returns.
struct Armed<'a>(&'a Watchdog);

impl Drop for Armed<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

/// Runs on the script's thread, between its instructions.
unsafe extern "C" fn check_stop(_isolate: v8::UnsafeRawIsolatePtr, _data: *mut c_void) {
    if should_stop()
        && let Some(engine) = ENGINES.with_borrow(|e| e.first().cloned())
    {
        // SAFETY: the interrupt runs on the isolate's thread, inside its script.
        unsafe { engine.isolate.as_ref() }.terminate_execution();
    }
}

/// A script's origin, for the file names and lines in its errors.
fn origin<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str, module: bool) -> v8::ScriptOrigin<'s> {
    let name = string(scope, name);
    v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, 0, None, false, false, module, None)
}

/// Runs a global script in strict mode, as QuickJS's global eval did, on the
/// same line so line numbers are unchanged.
fn run_script<'s>(scope: &mut v8::PinScope<'s, '_>, filename: &str, js: &str) -> std::result::Result<v8::Local<'s, v8::Value>, Failure> {
    let source = string(scope, &format!("\"use strict\";{js}"));
    let origin = origin(scope, filename, false);
    v8::tc_scope!(let tc, scope);
    let Some(script) = v8::Script::compile(tc, source, Some(&origin)) else { return Err(failure(tc)) };
    match script.run(tc) {
        Some(value) => Ok(escape(value)),
        None => Err(failure(tc)),
    }
}

/// A handle made in a try-catch scope, for the scope around it.
fn escape<'s>(value: v8::Local<'_, v8::Value>) -> v8::Local<'s, v8::Value> {
    // SAFETY: a TryCatch scope opens no handle scope of its own, so its
    // handles belong to the handle scope it is in.
    unsafe { std::mem::transmute(value) }
}

/// The module a package's name or file names, compiled once.
fn compile_module<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str) -> std::result::Result<v8::Local<'s, v8::Module>, Failure> {
    let Some((file, source)) = package_source(name) else {
        return Err(Failure::thrown("Error", format!("No package named {name}"), None, None, Vec::new()));
    };
    let engine = current();
    if let Some(module) = engine.modules.borrow().get(&file) {
        return Ok(v8::Local::new(scope, module));
    }
    let js = match stripped(&file) {
        Some(js) => js.to_string(),
        None => strip_module_types(&file, source.into_owned())
            .map_err(|e| Failure::thrown("SyntaxError", e.message().to_string(), None, None, Vec::new()))?,
    };
    let js = crate::module_js(&file, js);
    let text = string(scope, &js);
    let origin = origin(scope, &file, true);
    let mut source = v8::script_compiler::Source::new(text, Some(&origin));
    v8::tc_scope!(let tc, scope);
    let Some(module) = v8::script_compiler::compile_module(tc, &mut source) else { return Err(failure(tc)) };
    engine.modules.borrow_mut().insert(file, v8::Global::new(tc, module));
    // SAFETY: as in `escape`.
    Ok(unsafe { std::mem::transmute::<v8::Local<'_, v8::Module>, v8::Local<'s, v8::Module>>(module) })
}

/// Finds a package an import names, as Emacs's require finds a Lisp file:
/// `import { x } from "subr"` is packages/subr.ts.
fn resolve<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
    _referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe let scope, context);
    let name = specifier.to_rust_string_lossy(scope);
    match compile_module(scope, &name) {
        Ok(module) => Some(module),
        Err(f) => {
            throw(scope, &f.into_error());
            None
        }
    }
}

/// Imports a module and runs it, if it has not run, giving its namespace.
fn import<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str) -> std::result::Result<v8::Local<'s, v8::Value>, Failure> {
    let module = compile_module(scope, name)?;
    v8::tc_scope!(let tc, scope);
    if module.get_status() == v8::ModuleStatus::Uninstantiated && module.instantiate_module(tc, resolve).is_none() {
        return Err(failure(tc));
    }
    if module.get_status() == v8::ModuleStatus::Instantiated {
        let Some(promise) = module.evaluate(tc) else { return Err(failure(tc)) };
        tc.perform_microtask_checkpoint();
        if let Ok(promise) = v8::Local::<v8::Promise>::try_from(promise)
            && promise.state() == v8::PromiseState::Rejected
        {
            let reason = promise.result(tc);
            // Reported here, not again as a rejection nothing handled.
            UNHANDLED.with_borrow_mut(|u| u.retain(|(p, _)| v8::Local::new(tc, p) != promise));
            return Err(failure_of(tc, reason));
        }
    }
    if module.get_status() == v8::ModuleStatus::Errored {
        let exception = module.get_exception();
        return Err(failure_of(tc, exception));
    }
    Ok(escape(module.get_module_namespace()))
}

/// `import("treesit")`: a promise of the package's namespace.
fn import_dynamically<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _options: v8::Local<'s, v8::Data>,
    _resource: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let name = specifier.to_rust_string_lossy(scope);
    match import(scope, &name) {
        Ok(namespace) => {
            resolver.resolve(scope, namespace);
        }
        Err(f) => {
            let error = error_value(scope, &f.into_error());
            resolver.reject(scope, error);
        }
    }
    Some(resolver.get_promise(scope))
}

/// What a failed script threw, as the try-catch scope caught it.
fn failure(tc: &mut v8::PinnedRef<'_, v8::TryCatch<'_, '_, v8::HandleScope<'_>>>) -> Failure {
    if tc.has_terminated() {
        return Failure::stopped(None);
    }
    match tc.exception() {
        Some(exception) => {
            let exception = escape(exception);
            failure_of(tc, exception)
        }
        None => Failure::thrown("Error", "Script failed".into(), None, None, Vec::new()),
    }
}

/// What a script threw, from the value thrown.
fn failure_of<'s>(scope: &mut v8::PinScope<'s, '_>, thrown: v8::Local<'s, v8::Value>) -> Failure {
    let Ok(object) = v8::Local::<v8::Object>::try_from(thrown) else {
        let message = thrown.to_rust_string_lossy(scope);
        return Failure { message, is_bug: false, location: None, symbol: None, data: Vec::new() };
    };
    if !thrown.is_native_error() && get(scope, object, "message").is_none_or(|m| m.is_undefined()) {
        let message = thrown.to_rust_string_lossy(scope);
        return Failure { message, is_bug: false, location: None, symbol: None, data: Vec::new() };
    }
    let text = |scope: &mut v8::PinScope<'s, '_>, key: &str| {
        get(scope, object, key).filter(|v| !v.is_null_or_undefined()).map(|v| v.to_rust_string_lossy(scope))
    };
    let name = text(scope, "name").unwrap_or_default();
    let message = text(scope, "message").unwrap_or_default();
    let stack = text(scope, "stack");
    let symbol = text(scope, "symbol");
    let data = match get(scope, object, "data").map(v8::Local::<v8::Array>::try_from) {
        Some(Ok(list)) => {
            let mut data = Vec::new();
            for i in 0..list.length() {
                if let Some(v) = list.get_index(scope, i)
                    && let Ok(v) = value_from_js(scope, v)
                {
                    data.push(v);
                }
            }
            data
        }
        _ => Vec::new(),
    };
    Failure::thrown(&name, message, stack.as_deref(), symbol, data)
}

/// An Error carrying a core error's condition, as Emacs's signal:
/// `.symbol`, `.data` and `.conditions`, for conditionCase.
fn error_value<'s>(scope: &mut v8::PinScope<'s, '_>, e: &Error) -> v8::Local<'s, v8::Value> {
    let message = string(scope, e.message());
    let exception = v8::Exception::error(scope, message);
    if let Ok(object) = v8::Local::<v8::Object>::try_from(exception) {
        let symbol = string(scope, e.symbol());
        set(scope, object, "symbol", symbol.into());
        let data: Vec<v8::Local<v8::Value>> = e.data().iter().filter_map(|v| value_to_js(scope, v).ok()).collect();
        let data = v8::Array::new_with_elements(scope, &data);
        set(scope, object, "data", data.into());
        let conditions: Vec<v8::Local<v8::Value>> =
            e8_core::error_conditions(e.symbol()).iter().map(|c| string(scope, c).into()).collect();
        let conditions = v8::Array::new_with_elements(scope, &conditions);
        set(scope, object, "conditions", conditions.into());
    }
    exception
}

/// Throws a core error to the script.
pub(crate) fn throw(scope: &mut v8::PinScope<'_, '_>, e: &Error) -> Thrown {
    let error = error_value(scope, e);
    scope.throw_exception(error);
    Thrown
}

/// Forgets an editor function a script's function called, once the
/// script has none left that call it.
pub(crate) fn forget_function(id: u64) {
    let Some(engine) = ENGINES.with_borrow(|e| e.last().cloned()) else { return };
    let mut functions = engine.functions.borrow_mut();
    if let Some((_, held)) = functions.get_mut(&id) {
        *held -= 1;
        if *held == 0 {
            functions.remove(&id);
        }
    }
}

/// Collects garbage in the running script's isolate; a FinalizationRegistry's
/// cleanup then runs as the outermost entry finishes.
pub(crate) fn collect_garbage() {
    if let Some(engine) = ENGINES.with_borrow(|e| e.last().cloned()) {
        // SAFETY: the isolate is this thread's, and a native is running in it.
        unsafe { &mut *engine.isolate.as_ptr() }.low_memory_notification();
    }
}

/// Runs a native's body so that a panic in it, in the native or in the
/// core under it, is an error the script sees: unwinding out of V8's
/// callback, an `extern "C"` function, would abort the editor.
pub(crate) fn catching<'s, 'i>(scope: &mut v8::PinScope<'s, 'i>, f: impl FnOnce(&mut v8::PinScope<'s, 'i>)) {
    if let Err(panic) = crate::catch_native(|| f(&mut *scope)) {
        throw(scope, &Error::new(format!("Internal error: {}", crate::panic_message(&*panic))));
    }
}

/// Gives a native the editor, throwing its error to the script. See [`editor_call`].
pub(crate) fn with_editor<T>(scope: &mut v8::PinScope<'_, '_>, safe_point: bool, f: impl FnOnce(&mut Editor) -> Result<T>) -> std::result::Result<T, Thrown> {
    editor_call(safe_point, f).map_err(|e| throw(scope, &e))
}

/// Puts a native on `native`, and on `api` if it is public.
pub(crate) fn define<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    native: v8::Local<'s, v8::Object>,
    api: v8::Local<'s, v8::Object>,
    name: &str,
    public: bool,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let f = v8::Function::new(scope, callback).expect("a native is made");
    set(scope, native, name, f.into());
    if public {
        set(scope, api, name, f.into());
    }
}

/// A string, which V8 makes unless it is too long.
pub(crate) fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::String> {
    v8::String::new(scope, s).unwrap_or_else(|| v8::String::empty(scope))
}

/// An object's property, or none if getting it threw.
pub(crate) fn get<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>, key: &str) -> Option<v8::Local<'s, v8::Value>> {
    let key = string(scope, key);
    object.get(scope, key.into())
}

pub(crate) fn set<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>, key: &str, value: v8::Local<'s, v8::Value>) {
    let key = string(scope, key);
    object.set(scope, key.into(), value);
}

/// Calls a function of the prelude's on the global object.
fn call_global<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str, args: &[v8::Local<'s, v8::Value>]) -> Js<'s> {
    let global = scope.get_current_context().global(scope);
    let f = get(scope, global, name).ok_or(Thrown)?;
    let f = v8::Local::<v8::Function>::try_from(f).map_err(|_| throw(scope, &Error::new(format!("The prelude has no {name}"))))?;
    let undefined = v8::undefined(scope).into();
    f.call(scope, undefined, args).ok_or(Thrown)
}

fn number<'s>(scope: &mut v8::PinScope<'s, '_>, n: f64) -> v8::Local<'s, v8::Value> {
    v8::Number::new(scope, n).into()
}

/// A script object the editor holds as a value.
pub(crate) struct KeptObject {
    // Declared before `engine` so the handle is freed while the isolate lives.
    value: v8::Global<v8::Value>,
    _engine: Rc<Inner>,
}

/// A script function the editor holds on to, as a command or a hook function.
pub(crate) struct ScriptFunction {
    // Declared before `engine` so the handle is freed while the isolate lives.
    run: v8::Global<v8::Function>,
    engine: Rc<Inner>,
}

impl ScriptFunction {
    fn new(scope: &mut v8::PinScope<'_, '_>, f: v8::Local<'_, v8::Function>) -> ScriptFunction {
        ScriptFunction { run: v8::Global::new(scope, f), engine: current() }
    }

    /// Calls the function with arguments made in the scope.
    fn invoke<R>(
        &self,
        ed: &mut Editor,
        args: impl for<'s> FnOnce(&mut v8::PinScope<'s, '_>) -> std::result::Result<Vec<v8::Local<'s, v8::Value>>, Thrown>,
        result: impl for<'s> FnOnce(&mut v8::PinScope<'s, '_>, v8::Local<'s, v8::Value>) -> Result<R>,
    ) -> Result<R> {
        enter(&self.engine, ed, |scope| {
            let f = v8::Local::new(scope, &self.run);
            v8::tc_scope!(let tc, scope);
            let Ok(args) = args(tc) else { return Err(failure(tc).into_error()) };
            let undefined = v8::undefined(tc).into();
            match f.call(tc, undefined, &args) {
                Some(value) => {
                    let value = escape(value);
                    result(tc, value)
                }
                None => Err(failure(tc).into_error()),
            }
        })
    }

    /// Runs the function as a command, with its arguments as scripts take them.
    fn call(&self, ed: &mut Editor, args: &[Arg]) -> Result<()> {
        self.invoke(ed, |scope| args.iter().map(|a| arg_to_js(scope, a)).collect(), |_, _| Ok(()))
    }

    /// Calls the function with editor values and returns what it returns,
    /// as a function value's call; what no value can hold, a BigInt, is t.
    fn call_returning(&self, ed: &mut Editor, args: &[EditorValue]) -> Result<EditorValue> {
        self.invoke(
            ed,
            |scope| args.iter().map(|a| value_to_js(scope, a)).collect(),
            |scope, value| match convert_from_js(scope, value) {
                Ok(value) => Ok(value.unwrap_or(EditorValue::Bool(true))),
                Err(Thrown) => Err(Error::new("A value could not be converted")),
            },
        )
    }

    /// Calls the function with the arguments read so far, for the names it
    /// returns, as a parameter's collection.
    fn call_for_names(&self, ed: &mut Editor, args: &[Arg]) -> Result<Vec<String>> {
        let args: Vec<String> = args.iter().map(Arg::to_string).collect();
        self.invoke(
            ed,
            |scope| Ok(args.iter().map(|a| string(scope, a).into()).collect()),
            |scope, value| {
                let list = v8::Local::<v8::Array>::try_from(value).map_err(|_| Error::new("A collection is a list of names"))?;
                Ok((0..list.length()).filter_map(|i| list.get_index(scope, i)).map(|v| v.to_rust_string_lossy(scope)).collect())
            },
        )
    }

    /// Calls the function with the arguments read so far, for the text it
    /// returns, as a parameter's prompt.
    fn call_for_text(&self, ed: &mut Editor, args: &[Arg]) -> Result<String> {
        let args: Vec<String> = args.iter().map(Arg::to_string).collect();
        self.invoke(ed, |scope| Ok(args.iter().map(|a| string(scope, a).into()).collect()), |scope, value| {
            Ok(value.to_rust_string_lossy(scope))
        })
    }
}

/// A command's argument as a script's command gets it.
fn arg_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, arg: &Arg) -> Js<'s> {
    match arg {
        Arg::Int(n) => Ok(number(scope, *n as f64)),
        Arg::Prefix(prefix) => prefix_to_js(scope, *prefix),
        other => Ok(string(scope, &other.to_string()).into()),
    }
}

fn install_native(scope: &mut v8::PinScope<'_, '_>) {
    let native = v8::Object::new(scope);
    let api = v8::Object::new(scope);
    natives::install(scope, native, api);
    let global = scope.get_current_context().global(scope);
    set(scope, global, "__e8Api", api.into());
    // The one native that needs the engine itself: a command keeps the
    // script's functions for its prompts, collections and starting input.
    let define = v8::Function::new(scope, define_command).expect("defineCommand is made");
    set(scope, native, "defineCommand", define.into());
    // And one that imports a package while a script runs.
    let require = v8::Function::new(scope, require).expect("require is made");
    set(scope, native, "require", require.into());
    set(scope, global, "__e8", native.into());
}

/// `native.require(feature)`: imports the package, if it has not been, and
/// whether there is one by that name.
fn require<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue<'s, v8::Value>) {
    catching(scope, |scope| {
        let feature = args.get(0).to_rust_string_lossy(scope);
        let Ok(found) = with_editor(scope, true, |ed| Ok(prepare_require(ed, &feature))) else { return };
        if found && let Err(f) = import(scope, &feature) {
            throw(scope, &f.into_error());
            return;
        }
        rv.set_bool(found);
    });
}

/// `native.defineCommand(name, doc, params, run, shiftSelect)`.
fn define_command<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, _rv: v8::ReturnValue<'s, v8::Value>) {
    catching(scope, |scope| {
        let _ = define_command_with(scope, &args);
    });
}

fn define_command_with<'s>(scope: &mut v8::PinScope<'s, '_>, args: &v8::FunctionCallbackArguments<'s>) -> std::result::Result<(), Thrown> {
    let command = values::command_from_js(scope, [args.get(0), args.get(1), args.get(2), args.get(3), args.get(4)])?;
    with_editor(scope, true, |ed| {
        ed.define_command(command);
        Ok(())
    })
}

impl values::Held for ScriptFunction {
    fn call(&self, ed: &mut Editor, args: &[Arg]) -> Result<()> {
        ScriptFunction::call(self, ed, args)
    }

    fn call_for_names(&self, ed: &mut Editor, args: &[Arg]) -> Result<Vec<String>> {
        ScriptFunction::call_for_names(self, ed, args)
    }

    fn call_for_text(&self, ed: &mut Editor, args: &[Arg]) -> Result<String> {
        ScriptFunction::call_for_text(self, ed, args)
    }
}

/// A match as a script sees it: `{ start, end, groups }`.
fn match_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, m: &e8_core::Match) -> Js<'s> {
    values::match_to_js(scope, m)
}

fn props_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, props: &e8_core::Props) -> Js<'s> {
    values::props_to_js(scope, props)
}

/// Face attributes from an object, as [`values::face_attrs_from_js`] reads them.
fn face_attrs_from_js<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>) -> std::result::Result<FaceAttrs, Thrown> {
    values::face_attrs_from_js(scope, &object.into())
}

/// An object's own enumerable keys.
fn keys<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>) -> Vec<String> {
    let Some(names) = object.get_own_property_names(scope, Default::default()) else { return Vec::new() };
    (0..names.length()).filter_map(|i| names.get_index(scope, i)).map(|k| k.to_rust_string_lossy(scope)).collect()
}

/// Each attribute in such an object, as its Emacs name and value.
fn face_attr_values_from_js<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    object: v8::Local<'s, v8::Object>,
) -> std::result::Result<Vec<(String, EditorValue)>, Thrown> {
    values::face_attr_values_from_js(scope, &object.into())
}

fn posn_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, posn: Option<e8_core::layout::Posn>) -> Js<'s> {
    values::posn_to_js(scope, posn)
}

fn face_attrs_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, attrs: &FaceAttrs) -> Js<'s> {
    values::face_attrs_to_js(scope, attrs)
}

fn plist_or_value_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, value: &EditorValue) -> Js<'s> {
    values::plist_or_value_to_js(scope, value)
}

fn value_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, value: &EditorValue) -> Js<'s> {
    values::value_to_js(scope, value)
}

fn text_from_js<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>) -> std::result::Result<e8_core::Text, Thrown> {
    values::text_from_js(scope, value)
}

/// The property a script function keeps its editor identity in, so the
/// same function passed twice is one value, as one lambda is `eq` to itself.
const FUNCTION_ID: &str = "__e8FunctionId";

/// A function value as a script sees it: a script's own function given
/// back as itself, and any other as a function that calls it.
fn function_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, function: &e8_core::Function) -> Js<'s> {
    if let Some(script) = function.origin().and_then(|o| o.downcast_ref::<ScriptFunction>()) {
        return Ok(v8::Local::new(scope, &script.run).into());
    }
    current().functions.borrow_mut().entry(function.id()).or_insert_with(|| (function.clone(), 0)).1 += 1;
    let id = number(scope, function.id() as f64);
    let js = v8::Function::builder(call_editor_function).data(id).build(scope).ok_or(Thrown)?;
    call_global(scope, "__e8TrackFunction", &[js.into(), id])?;
    set(scope, js.into(), FUNCTION_ID, id);
    if let Some(name) = function.name() {
        let name = string(scope, name).into();
        set(scope, js.into(), "displayName", name);
    }
    Ok(js.into())
}

/// The function a script gets for an editor function.
fn call_editor_function<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue<'s, v8::Value>) {
    catching(scope, |scope| {
        let id = args.data().number_value(scope).unwrap_or(-1.0) as u64;
        let Some(function) = current().functions.borrow().get(&id).map(|(f, _)| f.clone()) else { return };
        let mut values = Vec::with_capacity(args.length() as usize);
        for i in 0..args.length() {
            let Ok(v) = value_from_js(scope, args.get(i)) else { return };
            values.push(v);
        }
        let Ok(result) = with_editor(scope, true, |ed| function.call(ed, &values)) else { return };
        if let Ok(value) = value_to_js(scope, &result) {
            rv.set(value);
        }
    });
}

/// A script's function as an editor value, keeping the identity it had
/// the last time it was one.
fn function_from_js<'s>(scope: &mut v8::PinScope<'s, '_>, f: v8::Local<'s, v8::Function>) -> std::result::Result<EditorValue, Thrown> {
    let known = number_property(scope, f.into(), FUNCTION_ID);
    let name = f.get_name(scope).to_rust_string_lossy(scope);
    let name = Some(name).filter(|n| !n.is_empty());
    let script = Rc::new(ScriptFunction::new(scope, f));
    let call = script.clone();
    let function = e8_core::Function::new(name.as_deref(), move |ed, args| call.call_returning(ed, args)).with_origin(script);
    Ok(EditorValue::Function(match known {
        Some(id) => function.with_id(id as u64),
        None => {
            let id = number(scope, function.id() as f64);
            set(scope, f.into(), FUNCTION_ID, id);
            function
        }
    }))
}

pub(crate) fn value_from_js<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>) -> std::result::Result<EditorValue, Thrown> {
    values::value_from_js(scope, value)
}

/// A number a property holds, if it holds one.
fn number_property<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>, key: &str) -> Option<f64> {
    get(scope, object, key).filter(|v| v.is_number()).and_then(|v| v.number_value(scope))
}

pub(crate) fn convert_from_js<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> std::result::Result<Option<EditorValue>, Thrown> {
    values::convert_from_js(scope, value)
}

/// What the shared value layer needs of V8, on a handle scope.
impl<'s> values::Scope for v8::PinScope<'s, '_> {
    type Value = v8::Local<'s, v8::Value>;
    type Error = Thrown;
    type Held = ScriptFunction;
    type Kept = KeptObject;

    fn hold(&mut self, value: &v8::Local<'s, v8::Value>) -> Option<ScriptFunction> {
        let f = v8::Local::<v8::Function>::try_from(*value).ok()?;
        Some(ScriptFunction::new(self, f))
    }

    fn keep(&mut self, value: &v8::Local<'s, v8::Value>) -> KeptObject {
        KeptObject { value: v8::Global::new(self, *value), _engine: current() }
    }

    fn restore(&mut self, kept: &KeptObject) -> Js<'s> {
        Ok(v8::Local::new(self, &kept.value))
    }

    fn null(&mut self) -> v8::Local<'s, v8::Value> {
        v8::null(self).into()
    }

    fn undefined(&mut self) -> v8::Local<'s, v8::Value> {
        v8::undefined(self).into()
    }

    fn boolean(&mut self, b: bool) -> v8::Local<'s, v8::Value> {
        v8::Boolean::new(self, b).into()
    }

    fn number(&mut self, n: f64) -> v8::Local<'s, v8::Value> {
        number(self, n)
    }

    fn string(&mut self, s: &str) -> Js<'s> {
        Ok(string(self, s).into())
    }

    fn array(&mut self, items: Vec<v8::Local<'s, v8::Value>>) -> Js<'s> {
        Ok(v8::Array::new_with_elements(self, &items).into())
    }

    fn object(&mut self) -> Js<'s> {
        Ok(v8::Object::new(self).into())
    }

    fn set(&mut self, object: &v8::Local<'s, v8::Value>, key: &str, value: v8::Local<'s, v8::Value>) -> std::result::Result<(), Thrown> {
        let object = v8::Local::<v8::Object>::try_from(*object).map_err(|_| throw(self, &Error::new("Not an object")))?;
        set(self, object, key, value);
        Ok(())
    }

    fn symbol_for(&mut self, name: &str) -> Js<'s> {
        let name = string(self, name);
        Ok(v8::Symbol::for_key(self, name).into())
    }

    fn call_global(&mut self, name: &str, args: Vec<v8::Local<'s, v8::Value>>) -> Js<'s> {
        call_global(self, name, &args)
    }

    fn function_to_js(&mut self, function: &e8_core::Function) -> Js<'s> {
        function_to_js(self, function)
    }

    fn is_nullish(&mut self, value: &v8::Local<'s, v8::Value>) -> bool {
        value.is_null_or_undefined()
    }

    fn as_bool(&mut self, value: &v8::Local<'s, v8::Value>) -> Option<bool> {
        value.is_boolean().then(|| value.is_true())
    }

    fn as_number(&mut self, value: &v8::Local<'s, v8::Value>) -> Option<f64> {
        value.is_number().then(|| value.number_value(self).unwrap_or(f64::NAN))
    }

    fn as_string(&mut self, value: &v8::Local<'s, v8::Value>) -> Option<String> {
        value.is_string().then(|| value.to_rust_string_lossy(self))
    }

    fn array_items(&mut self, value: &v8::Local<'s, v8::Value>) -> std::result::Result<Option<Vec<v8::Local<'s, v8::Value>>>, Thrown> {
        let Ok(list) = v8::Local::<v8::Array>::try_from(*value) else { return Ok(None) };
        (0..list.length()).map(|i| list.get_index(self, i).ok_or(Thrown)).collect::<std::result::Result<Vec<_>, _>>().map(Some)
    }

    fn function_from_js(&mut self, value: &v8::Local<'s, v8::Value>) -> std::result::Result<Option<EditorValue>, Thrown> {
        match v8::Local::<v8::Function>::try_from(*value) {
            Ok(f) => function_from_js(self, f).map(Some),
            Err(_) => Ok(None),
        }
    }

    fn symbol_description(&mut self, value: &v8::Local<'s, v8::Value>) -> Option<Option<String>> {
        let symbol = v8::Local::<v8::Symbol>::try_from(*value).ok()?;
        let description = symbol.description(self);
        Some((!description.is_undefined()).then(|| description.to_rust_string_lossy(self)))
    }

    fn is_object(&mut self, value: &v8::Local<'s, v8::Value>) -> bool {
        value.is_object()
    }

    fn is_plain_object(&mut self, value: &v8::Local<'s, v8::Value>) -> bool {
        value.is_object() && !value.is_array() && !value.is_function() && !value.is_string() && !value.is_string_object()
    }

    fn get(&mut self, object: &v8::Local<'s, v8::Value>, key: &str) -> std::result::Result<Option<v8::Local<'s, v8::Value>>, Thrown> {
        let Ok(object) = v8::Local::<v8::Object>::try_from(*object) else { return Ok(None) };
        // None only when getting it threw.
        let value = get(self, object, key).ok_or(Thrown)?;
        Ok((!value.is_undefined()).then_some(value))
    }

    fn keys(&mut self, object: &v8::Local<'s, v8::Value>) -> std::result::Result<Vec<String>, Thrown> {
        let Ok(object) = v8::Local::<v8::Object>::try_from(*object) else { return Ok(Vec::new()) };
        Ok(keys(self, object))
    }

    fn throw(&mut self, e: &Error) -> Thrown {
        throw(self, e)
    }

    fn throw_type(&mut self, message: &str) -> Thrown {
        let message = string(self, message);
        let error = v8::Exception::type_error(self, message);
        self.throw_exception(error);
        Thrown
    }
}

fn prefix_to_js<'s>(scope: &mut v8::PinScope<'s, '_>, arg: Option<PrefixArg>) -> Js<'s> {
    values::prefix_to_js(scope, arg)
}

fn prefix_from_js<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>) -> std::result::Result<Option<PrefixArg>, Thrown> {
    values::prefix_from_js(scope, value)
}
