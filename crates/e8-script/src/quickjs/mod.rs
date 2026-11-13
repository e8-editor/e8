//! The QuickJS engine, through rquickjs: the runtime, entering it from the
//! editor, converting values, and the natives' binding.

mod bindings;

pub(crate) use bindings::{Param, Ret};

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::rc::Rc;

use e8_core::{Arg, Editor, Error, FaceAttrs, PrefixArg, Result, Value as EditorValue};
use rquickjs::context::EvalOptions;
use rquickjs::function::{Opt, Rest};
use rquickjs::{Coerced, Context, Ctx, Exception, FromJs, Function, Object, Persistent, Runtime, Value, qjs};

use crate::{
    EDITOR, Failure, Outermost, PRELUDE, Restore, editor_call, natives, nested_deadline, package_source, prepare_require, should_stop, strip_module_types,
    stripped, values,
};

thread_local! {
    /// The context of the script that is running, if any.
    static ACTIVE: Cell<Option<NonNull<qjs::JSContext>>> = const { Cell::new(None) };
    /// The contexts of the scripts running, innermost last, for functions
    /// made into editor values to call back into.
    static CONTEXTS: RefCell<Vec<Context>> = const { RefCell::new(Vec::new()) };
    /// Promises rejected with no handler yet, and why: an async command's
    /// error, reported once the code that settled it has finished.
    static UNHANDLED: RefCell<Vec<(Persistent<Value<'static>>, Persistent<Value<'static>>)>> = const { RefCell::new(Vec::new()) };
}

/// A QuickJS runtime with the `e8` global. Clones share it.
#[derive(Clone)]
pub(crate) struct Engine {
    context: Context,
}

impl Engine {
    /// Starts a runtime, installs the natives and runs the prelude.
    pub(crate) fn new(ed: &mut Editor) -> Result<Engine> {
        let runtime = Runtime::new().map_err(|e| Error::new(e.to_string()))?;
        runtime.set_loader(PackageResolver, PackageLoader);
        runtime.set_interrupt_handler(Some(Box::new(should_stop)));
        runtime.set_host_promise_rejection_tracker(Some(Box::new(|ctx, promise, reason, handled| {
            UNHANDLED.with_borrow_mut(|unhandled| {
                if handled {
                    unhandled.retain(|(p, _)| p.clone().restore(&ctx).map_or(true, |p| p != promise));
                } else {
                    unhandled.push((Persistent::save(&ctx, promise), Persistent::save(&ctx, reason)));
                }
            })
        })));
        let context = Context::full(&runtime).map_err(|e| Error::new(e.to_string()))?;
        let engine = Engine { context };
        enter(&engine.context, ed, |ctx| {
            install_native(&ctx).map_err(|e| js_error(&ctx, e))?;
            ctx.eval_with_options::<(), _>(PRELUDE, eval_options("e8:prelude")).map_err(|e| js_error(&ctx, e))
        })?;
        Ok(engine)
    }

    /// Imports a package, as an ES module, and what it imports.
    pub(crate) fn import(&self, ed: &mut Editor, name: &str) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            rquickjs::Module::import(&ctx, name)
                .and_then(|promise| promise.finish::<Value>())
                .map(drop)
                .map_err(|e| js_error_with_location(&ctx, e))
        })
    }

    /// Runs a script, its types already erased, as a global script.
    pub(crate) fn run(&self, ed: &mut Editor, filename: &str, js: String) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            ctx.eval_with_options::<(), _>(js, eval_options(filename)).map_err(|e| js_error_with_location(&ctx, e))
        })
    }

    /// Evaluates an expression and gives its value as JSON, or `undefined`.
    pub(crate) fn eval_json(&self, ed: &mut Editor, js: String) -> Result<String> {
        enter(&self.context, ed, |ctx| {
            let value: Value = ctx.eval_with_options(js, eval_options("expression")).map_err(|e| js_error(&ctx, e))?;
            match ctx.json_stringify(value).map_err(|e| js_error(&ctx, e))? {
                Some(json) => json.to_string().map_err(|e| js_error(&ctx, e)),
                None => Ok("undefined".to_string()),
            }
        })
    }
}

/// Finds a package by its feature name, as Emacs's require finds a Lisp
/// file: `import { x } from "subr"` is packages/subr.ts.
struct PackageResolver;

impl rquickjs::loader::Resolver for PackageResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        package_source(name).map(|(file, _)| file).ok_or_else(|| rquickjs::Error::new_resolving(base, name))
    }
}

/// Loads a package as an ES module, its types erased.
struct PackageLoader;

impl rquickjs::loader::Loader for PackageLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<rquickjs::Module<'js, rquickjs::module::Declared>> {
        let (file, source) = package_source(name).ok_or_else(|| rquickjs::Error::new_loading(name))?;
        let js = match stripped(&file) {
            Some(js) => js.to_string(),
            None => strip_module_types(&file, source.into_owned()).map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?,
        };
        let js = crate::module_js(&file, js);
        rquickjs::Module::declare(ctx.clone(), file, js)
    }
}

fn eval_options(filename: &str) -> EvalOptions {
    let mut options = EvalOptions::default();
    options.global = true;
    options.strict = true;
    options.filename = Some(filename.to_string());
    options
}

/// Takes the running script's context off [`CONTEXTS`] when dropped.
struct Popped;

impl Drop for Popped {
    fn drop(&mut self) {
        CONTEXTS.with_borrow_mut(|c| c.pop());
    }
}

/// Runs `f` in the script context, giving host functions access to `ed`.
///
/// QuickJS's runtime lock is not reentrant. When a script calls a command
/// that runs another script command, the nested call reuses the context of
/// the script that is already running instead of locking it again.
fn enter<R>(context: &Context, ed: &mut Editor, f: impl for<'js> FnOnce(Ctx<'js>) -> Result<R>) -> Result<R> {
    let _editor = Restore::set(&EDITOR, Some(NonNull::from(ed)));
    match ACTIVE.get() {
        Some(raw) if raw == context.as_raw() => {
            // SAFETY: ACTIVE is only set inside `Context::with` below, so the
            // runtime lock is held, and it is this context's runtime.
            let ctx = unsafe { Ctx::from_raw(raw) };
            let _deadline = nested_deadline();
            let result = f(ctx.clone());
            // A prompt answered from code already running, as keys a macro
            // replays, lets its command carry on here, where Emacs's would,
            // rather than once all the code has finished. Rejections nothing
            // handles are reported by the outermost call.
            while ctx.execute_pending_job() {}
            result
        }
        _ => context.with(|ctx| {
            CONTEXTS.with_borrow_mut(|c| c.push(context.clone()));
            let _context = Popped;
            let _active = Restore::set(&ACTIVE, Some(ctx.as_raw()));
            let outermost = Outermost::begin();
            let result = f(ctx.clone());
            outermost.unwind_if_stopped();
            // What waits on promises settled meanwhile runs now, before the
            // editor goes on: an async command awaiting a prompt carries on
            // as soon as the answer comes.
            while ctx.execute_pending_job() {}
            let unhandled = UNHANDLED.take();
            match (result, unhandled.into_iter().next()) {
                (Ok(_), Some((_, reason))) => Err(rejection_error(&ctx, reason)),
                (result, _) => result,
            }
        }),
    }
}


/// A command's argument as a script's command gets it.
fn arg_to_js<'js>(ctx: &Ctx<'js>, arg: &Arg) -> rquickjs::Result<Value<'js>> {
    match arg {
        Arg::Int(n) => Ok(Value::new_number(ctx.clone(), *n as f64)),
        Arg::Prefix(prefix) => prefix_to_js(ctx, *prefix),
        other => Ok(rquickjs::String::from_str(ctx.clone(), &other.to_string())?.into_value()),
    }
}

/// The editor functions scripts call are kept by their JavaScript
/// functions here, and freed with them: nothing to forget.
pub(crate) fn forget_function(_id: u64) {}

/// Collects garbage in the running script's runtime.
pub(crate) fn collect_garbage() {
    if let Some(raw) = ACTIVE.get() {
        // SAFETY: ACTIVE is the context of the script running, whose runtime lock is held.
        unsafe { Ctx::from_raw(raw) }.run_gc();
    }
}

/// Runs a native's body so that a panic in it, in the native or in the
/// core under it, is an error the script sees, as on V8.
pub(crate) fn catching<'js, T>(ctx: &Ctx<'js>, f: impl FnOnce() -> rquickjs::Result<T>) -> rquickjs::Result<T> {
    match crate::catch_native(f) {
        Ok(result) => result,
        Err(panic) => Err(throw_error(ctx, &Error::new(format!("Internal error: {}", crate::panic_message(&*panic))))),
    }
}

/// Gives a native the editor, throwing its error to the script. See [`editor_call`].
pub(crate) fn with_editor<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    editor_call(true, f).map_err(|e| throw_error(ctx, &e))
}

/// As [`with_editor`], but not a safe point.
pub(crate) fn with_editor_unchecked<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    editor_call(false, f).map_err(|e| throw_error(ctx, &e))
}

/// Throws a core error to a script as an Error carrying its condition, as
/// Emacs's signal: `.symbol`, `.data` and `.conditions`, for conditionCase.
fn throw_error(ctx: &Ctx<'_>, e: &Error) -> rquickjs::Error {
    let exception = match Exception::from_message(ctx.clone(), e.message()) {
        Ok(exception) => exception,
        Err(err) => return err,
    };
    let data: Vec<Value> = e.data().iter().filter_map(|v| value_to_js(ctx, v).ok()).collect();
    let _ = exception.set("symbol", e.symbol());
    let _ = exception.set("data", data);
    let _ = exception.set("conditions", e8_core::error_conditions(e.symbol()));
    ctx.throw(exception.into_value())
}

/// A script object the editor holds as a value.
pub(crate) struct KeptObject {
    // Declared before `context` so the object is freed before the runtime can be.
    value: Persistent<Value<'static>>,
    _context: Option<Context>,
}

/// A script function the editor holds on to, as a command or a hook function.
pub(crate) struct ScriptFunction {
    // Declared before `context` so the function is freed before the runtime can be.
    run: Persistent<Function<'static>>,
    context: Context,
}

impl ScriptFunction {
    /// Runs the function as a command, with its arguments as scripts take them.
    fn call(&self, ed: &mut Editor, args: &[Arg]) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            let args = args.iter().map(|a| arg_to_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>().map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Value>((Rest(args),))
                .map(drop)
                .map_err(|e| js_error(&ctx, e))
        })
    }

    /// Calls the function with editor values and returns what it returns,
    /// as a function value's call.
    fn call_returning(&self, ed: &mut Editor, args: &[EditorValue]) -> Result<EditorValue> {
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            let args = args
                .iter()
                .map(|a| value_to_js(&ctx, a))
                .collect::<rquickjs::Result<Vec<_>>>()
                .map_err(|e| js_error(&ctx, e))?;
            let value: Value = run.call((Rest(args),)).map_err(|e| js_error(&ctx, e))?;
            // What no value can hold, a BigInt, is still not nil: t.
            convert_from_js(&ctx, value).map(|v| v.unwrap_or(EditorValue::Bool(true))).map_err(|e| js_error(&ctx, e))
        })
    }

    /// Calls the function with the arguments read so far, for the names it
    /// returns, as a parameter's collection.
    fn call_for_names(&self, ed: &mut Editor, args: &[Arg]) -> Result<Vec<String>> {
        let args: Vec<String> = args.iter().map(Arg::to_string).collect();
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Vec<Coerced<String>>>((Rest(args),)).map(|v| v.into_iter().map(|s| s.0).collect()).map_err(|e| js_error(&ctx, e))
        })
    }

    /// Calls the function with the arguments read so far, for the text it
    /// returns, as a parameter's prompt.
    fn call_for_text(&self, ed: &mut Editor, args: &[Arg]) -> Result<String> {
        let args: Vec<String> = args.iter().map(Arg::to_string).collect();
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Coerced<String>>((Rest(args),)).map(|s| s.0).map_err(|e| js_error(&ctx, e))
        })
    }
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

fn install_native<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<()> {
    let native = Object::new(ctx.clone())?;
    let api = Object::new(ctx.clone())?;
    natives::install(ctx, &native, &api)?;
    ctx.globals().set("__e8Api", api)?;
    // The one native that needs the engine itself: a command keeps the
    // script's functions for its prompts, collections and starting input.
    native.set(
        "defineCommand",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, name: Value<'js>, doc: Value<'js>, params: Value<'js>, run: Value<'js>, shift_select: Opt<Value<'js>>| {
            let shift_select = shift_select.0.unwrap_or_else(|| Value::new_undefined(ctx.clone()));
            let command = values::command_from_js(&mut ctx.clone(), [name, doc, params, run, shift_select])?;
            with_editor(&ctx, |ed| {
                ed.define_command(command);
                Ok(())
            })
        })?,
    )?;
    // And one that imports a package while a script runs, and says
    // whether there is one by that name.
    native.set(
        "require",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, feature: String| {
            if !with_editor(&ctx, |ed| Ok(prepare_require(ed, &feature)))? {
                return Ok(false);
            }
            rquickjs::Module::import(&ctx, feature.as_str())?.finish::<Value>()?;
            Ok::<_, rquickjs::Error>(true)
        })?,
    )?;
    ctx.globals().set("__e8", native)
}

/// A match as a script sees it: `{ start, end, groups }`.
fn match_to_js<'js>(ctx: &Ctx<'js>, m: &e8_core::Match) -> rquickjs::Result<Value<'js>> {
    values::match_to_js(&mut ctx.clone(), m)
}

fn props_to_js<'js>(ctx: &Ctx<'js>, props: &e8_core::Props) -> rquickjs::Result<Value<'js>> {
    values::props_to_js(&mut ctx.clone(), props)
}

/// Face attributes from an object, as [`values::face_attrs_from_js`] reads them.
fn face_attrs_from_js<'js>(object: &Object<'js>) -> rquickjs::Result<FaceAttrs> {
    values::face_attrs_from_js(&mut object.ctx().clone(), &object.clone().into_value())
}

/// Each attribute in such an object, as its Emacs name and value.
fn face_attr_values_from_js<'js>(object: &Object<'js>) -> rquickjs::Result<Vec<(String, EditorValue)>> {
    values::face_attr_values_from_js(&mut object.ctx().clone(), &object.clone().into_value())
}

fn posn_to_js<'js>(ctx: &Ctx<'js>, posn: Option<e8_core::layout::Posn>) -> rquickjs::Result<Value<'js>> {
    values::posn_to_js(&mut ctx.clone(), posn)
}

fn face_attrs_to_js<'js>(ctx: &Ctx<'js>, attrs: &FaceAttrs) -> rquickjs::Result<Value<'js>> {
    values::face_attrs_to_js(&mut ctx.clone(), attrs)
}

fn plist_or_value_to_js<'js>(ctx: &Ctx<'js>, value: &EditorValue) -> rquickjs::Result<Value<'js>> {
    values::plist_or_value_to_js(&mut ctx.clone(), value)
}

fn value_to_js<'js>(ctx: &Ctx<'js>, value: &EditorValue) -> rquickjs::Result<Value<'js>> {
    values::value_to_js(&mut ctx.clone(), value)
}

fn text_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<e8_core::Text> {
    values::text_from_js(&mut ctx.clone(), value)
}

/// The property a script function keeps its editor identity in, so the
/// same function passed twice is one value, as one lambda is `eq` to itself.
const FUNCTION_ID: &str = "__e8FunctionId";

/// A function value as a script sees it: a script's own function given
/// back as itself, and any other as a function that calls it.
fn function_to_js<'js>(ctx: &Ctx<'js>, function: &e8_core::Function) -> rquickjs::Result<Value<'js>> {
    if let Some(script) = function.origin().and_then(|o| o.downcast_ref::<ScriptFunction>())
        && let Ok(f) = script.run.clone().restore(ctx)
    {
        return Ok(f.into_value());
    }
    let call = function.clone();
    let js = Function::new(ctx.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> rquickjs::Result<Value<'js>> {
        let args = args.0.into_iter().map(|a| value_from_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>()?;
        let result = with_editor(&ctx, |ed| call.call(ed, &args))?;
        value_to_js(&ctx, &result)
    })?;
    js.set(FUNCTION_ID, function.id() as f64)?;
    if let Some(name) = function.name() {
        let _ = js.set("displayName", name);
    }
    Ok(js.into_value())
}

/// A script's function as an editor value, keeping the identity it had
/// the last time it was one.
fn function_from_js<'js>(ctx: &Ctx<'js>, f: Function<'js>) -> rquickjs::Result<EditorValue> {
    let Some(context) = CONTEXTS.with_borrow(|c| c.last().cloned()) else {
        return Err(Exception::throw_internal(ctx, "No script is running"));
    };
    let known: Option<f64> = f.get(FUNCTION_ID)?;
    let name: Option<String> = f.get::<_, Option<Coerced<String>>>("name").ok().flatten().map(|n| n.0).filter(|n| !n.is_empty());
    let script = Rc::new(ScriptFunction { run: Persistent::save(ctx, f.clone()), context });
    let call = script.clone();
    let function = e8_core::Function::new(name.as_deref(), move |ed, args| call.call_returning(ed, args)).with_origin(script);
    Ok(EditorValue::Function(match known {
        Some(id) => function.with_id(id as u64),
        None => {
            // A frozen function cannot keep its identity, and works without
            // it, as on V8.
            if f.set(FUNCTION_ID, function.id() as f64).is_err() {
                let _ = ctx.catch();
            }
            function
        }
    }))
}

fn value_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<EditorValue> {
    values::value_from_js(&mut ctx.clone(), value)
}

fn convert_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<Option<EditorValue>> {
    values::convert_from_js(&mut ctx.clone(), value)
}

/// What the shared value layer needs of QuickJS, on a context.
impl<'js> values::Scope for Ctx<'js> {
    type Value = Value<'js>;
    type Error = rquickjs::Error;
    type Held = ScriptFunction;
    type Kept = KeptObject;

    fn hold(&mut self, value: &Value<'js>) -> Option<ScriptFunction> {
        let f = value.as_function()?;
        let context = CONTEXTS.with_borrow(|c| c.last().cloned())?;
        Some(ScriptFunction { run: Persistent::save(self, f.clone()), context })
    }

    fn keep(&mut self, value: &Value<'js>) -> KeptObject {
        KeptObject { value: Persistent::save(self, value.clone()), _context: CONTEXTS.with_borrow(|c| c.last().cloned()) }
    }

    fn restore(&mut self, kept: &KeptObject) -> rquickjs::Result<Value<'js>> {
        kept.value.clone().restore(self)
    }

    fn null(&mut self) -> Value<'js> {
        Value::new_null(self.clone())
    }

    fn undefined(&mut self) -> Value<'js> {
        Value::new_undefined(self.clone())
    }

    fn boolean(&mut self, b: bool) -> Value<'js> {
        Value::new_bool(self.clone(), b)
    }

    fn number(&mut self, n: f64) -> Value<'js> {
        Value::new_number(self.clone(), n)
    }

    fn string(&mut self, s: &str) -> rquickjs::Result<Value<'js>> {
        Ok(rquickjs::String::from_str(self.clone(), s)?.into_value())
    }

    fn array(&mut self, items: Vec<Value<'js>>) -> rquickjs::Result<Value<'js>> {
        let list = rquickjs::Array::new(self.clone())?;
        for (i, item) in items.into_iter().enumerate() {
            list.set(i, item)?;
        }
        Ok(list.into_value())
    }

    fn object(&mut self) -> rquickjs::Result<Value<'js>> {
        Ok(Object::new(self.clone())?.into_value())
    }

    fn set(&mut self, object: &Value<'js>, key: &str, value: Value<'js>) -> rquickjs::Result<()> {
        object.as_object().ok_or_else(|| Exception::throw_type(self, "Not an object"))?.set(key, value)
    }

    fn symbol_for(&mut self, name: &str) -> rquickjs::Result<Value<'js>> {
        let symbol: Object = self.globals().get("Symbol")?;
        let make: Function = symbol.get("for")?;
        make.call((name,))
    }

    fn call_global(&mut self, name: &str, args: Vec<Value<'js>>) -> rquickjs::Result<Value<'js>> {
        let f: Function = self.globals().get(name)?;
        f.call((Rest(args),))
    }

    fn function_to_js(&mut self, function: &e8_core::Function) -> rquickjs::Result<Value<'js>> {
        function_to_js(self, function)
    }

    fn is_nullish(&mut self, value: &Value<'js>) -> bool {
        value.is_null() || value.is_undefined()
    }

    fn as_bool(&mut self, value: &Value<'js>) -> Option<bool> {
        value.as_bool()
    }

    fn as_number(&mut self, value: &Value<'js>) -> Option<f64> {
        value.as_number()
    }

    fn as_string(&mut self, value: &Value<'js>) -> Option<String> {
        value.as_string().and_then(|s| s.to_string().ok())
    }

    fn array_items(&mut self, value: &Value<'js>) -> rquickjs::Result<Option<Vec<Value<'js>>>> {
        let Some(list) = value.as_array() else { return Ok(None) };
        (0..list.len()).map(|i| list.get(i)).collect::<rquickjs::Result<Vec<_>>>().map(Some)
    }

    fn function_from_js(&mut self, value: &Value<'js>) -> rquickjs::Result<Option<EditorValue>> {
        match value.as_function() {
            Some(f) => function_from_js(self, f.clone()).map(Some),
            None => Ok(None),
        }
    }

    fn symbol_description(&mut self, value: &Value<'js>) -> Option<Option<String>> {
        let symbol = value.as_symbol()?;
        Some(symbol.description().ok().and_then(|d| d.as_string().and_then(|s| s.to_string().ok())))
    }

    fn is_object(&mut self, value: &Value<'js>) -> bool {
        value.as_object().is_some()
    }

    fn is_plain_object(&mut self, value: &Value<'js>) -> bool {
        value.as_object().is_some() && !value.is_array() && !value.is_function() && value.as_string().is_none()
    }

    fn get(&mut self, object: &Value<'js>, key: &str) -> rquickjs::Result<Option<Value<'js>>> {
        let Some(object) = object.as_object() else { return Ok(None) };
        let value: Value<'js> = object.get(key)?;
        Ok((!value.is_undefined()).then_some(value))
    }

    fn keys(&mut self, object: &Value<'js>) -> rquickjs::Result<Vec<String>> {
        let Some(object) = object.as_object() else { return Ok(Vec::new()) };
        object.keys::<String>().collect()
    }

    fn throw(&mut self, e: &Error) -> rquickjs::Error {
        throw_error(self, e)
    }

    fn throw_type(&mut self, message: &str) -> rquickjs::Error {
        Exception::throw_type(self, message)
    }
}

fn prefix_to_js<'js>(ctx: &Ctx<'js>, arg: Option<PrefixArg>) -> rquickjs::Result<Value<'js>> {
    values::prefix_to_js(&mut ctx.clone(), arg)
}

fn prefix_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<Option<PrefixArg>> {
    values::prefix_from_js(&mut ctx.clone(), value)
}

/// What a failed script threw.
fn failure(ctx: &Ctx<'_>, err: rquickjs::Error) -> Failure {
    if !err.is_exception() {
        return Failure { message: err.to_string(), is_bug: true, location: None, symbol: None, data: Vec::new() };
    }
    let value = ctx.catch();
    let Some(exception) = value.as_exception() else {
        // An object with a message, as an error class of a script's own
        // not built on Error, is read as an error is, as on V8.
        if let Some(object) = value.as_object()
            && let Ok(Some(message)) = object.get::<_, Option<String>>("message")
        {
            let name: String = object.get::<_, Option<String>>("name").ok().flatten().unwrap_or_default();
            let stack: Option<String> = object.get("stack").ok().flatten();
            let symbol: Option<String> = object.get("symbol").ok().flatten();
            let data: Vec<EditorValue> = object
                .get::<_, Option<Vec<Value>>>("data")
                .ok()
                .flatten()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| value_from_js(ctx, v).ok())
                .collect();
            return Failure::thrown(&name, message, stack.as_deref(), symbol, data);
        }
        let message = Coerced::<String>::from_js(ctx, value)
            .map(|s| s.0)
            .unwrap_or_else(|_| "Script threw a value that is not an Error".into());
        return Failure { message, is_bug: false, location: None, symbol: None, data: Vec::new() };
    };
    let message = exception.message().unwrap_or_default();
    let name: String = exception.get("name").unwrap_or_default();
    let stack = exception.stack();
    if name == "InternalError" && message == "interrupted" {
        return Failure::stopped(stack.as_deref().and_then(crate::first_location));
    }
    let symbol: Option<String> = exception.get("symbol").ok().flatten();
    let data: Vec<EditorValue> = exception
        .get::<_, Option<Vec<Value>>>("data")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| value_from_js(ctx, v).ok())
        .collect();
    Failure::thrown(&name, message, stack.as_deref(), symbol, data)
}

/// An error for a failed command.
fn js_error(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    failure(ctx, err).into_error()
}

/// The error a promise was rejected with, as the editor shows it.
fn rejection_error(ctx: &Ctx<'_>, reason: Persistent<Value<'static>>) -> Error {
    match reason.restore(ctx) {
        Ok(reason) => {
            let thrown = ctx.throw(reason);
            js_error(ctx, thrown)
        }
        Err(e) => js_error(ctx, e),
    }
}

/// An error for a failed file load.
fn js_error_with_location(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    failure(ctx, err).into_error_with_location()
}
