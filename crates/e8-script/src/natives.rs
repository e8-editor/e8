//! The table of native functions: each one written once, by name, with its
//! parameters' and result's types and its documentation, in the `natives!`
//! tables of the modules under `natives/`.
//!
//! An entry is a function of the editor and its arguments, in Rust types,
//! with nothing of the script engine in it:
//!
//! ```ignore
//! natives! {
//!     /// The column point is on, as current-column.
//!     pub fn currentColumn(ed) -> usize {
//!         Ok(ed.current_column())
//!     }
//! }
//! ```
//!
//! From the table the macro writes the engine's binding: a function on the
//! prelude's `native` object that converts the arguments ([`Param`]), runs
//! the body with the editor (`with_editor`, so every call is a safe point
//! for quitting) and converts the result back ([`Ret`]). An entry marked
//! `pub` is also `e8.NAME` itself, with no wrapper in prelude.js, and
//! [`declarations`] writes its declaration in `e8.d.ts` from its
//! documentation and types, or from a `#[ts = "..."]` signature where the
//! TypeScript says more than the Rust types do. Another engine is another
//! set of [`Param`] and [`Ret`] implementations and another arm of the
//! macro; the entries stay as they are.
//!
//! Every call is a safe point, where a quit asked for is signalled, except
//! for an entry marked `#[safe_point = false]`, which must run while a quit
//! unwinds (`unbind`) or reads the quit flag itself.
//!
//! Natives that need the engine itself (`defineCommand`, which keeps a
//! script's functions as its prompts and collections) are written by hand
//! in each engine's module, on what values.rs shares.

mod bidi;
mod chartab;
mod editor;
mod files;
mod images;
mod processes;
mod search;
mod text;
mod treesit;
pub(crate) mod variables;
mod windows;

use e8_core::{PrefixArg, Value as EditorValue};

/// A native function, as its entry in a table describes it.
pub(crate) struct Native {
    pub name: &'static str,
    pub doc: &'static str,
    /// Each parameter's name and Rust type.
    pub params: &'static [(&'static str, &'static str)],
    pub ret: &'static str,
    /// Whether it is `e8.NAME` as well as `native.NAME`.
    pub public: bool,
    /// Its TypeScript signature, as `(a: string): number`, where the one
    /// worked out from the Rust types would say less.
    pub ts: Option<&'static str>,
}

/// Defines native functions: see the module's documentation.
macro_rules! natives {
    (@ts) => { None };
    (@ts $ts:literal) => { Some($ts) };
    (@ret) => { () };
    (@ret $ret:ty) => { $ret };
    (@retname) => { "()" };
    (@retname $ret:ty) => { stringify!($ret) };
    ($(
        $(#[doc = $doc:literal])*
        $(#[ts = $ts:literal])?
        $(#[safe_point = $safe_point:literal])?
        $vis:vis fn $name:ident($ed:ident $(, $arg:ident: $ty:ty)* $(,)?) $(-> $ret:ty)? $body:block
    )*) => {
        #[allow(non_snake_case, unused_imports, unused_variables, unused_mut, clippy::needless_question_mark, clippy::unnecessary_wraps, clippy::too_many_arguments)]
        mod body {
            use super::*;
            $(
                pub(super) fn $name($ed: &mut e8_core::Editor $(, $arg: $ty)*) -> e8_core::Result<natives!(@ret $($ret)?)> $body
            )*
        }

        /// This module's natives.
        pub(crate) const TABLE: &[$crate::natives::Native] = &[$(
            $crate::natives::Native {
                name: stringify!($name),
                doc: concat!($($doc, "\n",)*),
                params: &[$((stringify!($arg), stringify!($ty))),*],
                ret: natives!(@retname $($ret)?),
                public: !stringify!($vis).is_empty(),
                ts: natives!(@ts $($ts)?),
            },
        )*];

        /// Puts this module's natives on `native`, and the public ones on `api`.
        #[cfg(feature = "quickjs")]
        pub(crate) fn install<'js>(
            ctx: &rquickjs::Ctx<'js>,
            native: &rquickjs::Object<'js>,
            api: &rquickjs::Object<'js>,
        ) -> rquickjs::Result<()> {
            $(
                let function = rquickjs::Function::new(
                    ctx.clone(),
                    |ctx: rquickjs::Ctx<'js>
                     $(, $arg: <$ty as $crate::engine::Param>::Js<'js>)*|
                     -> rquickjs::Result<rquickjs::Value<'js>> {
                        $crate::engine::catching(&ctx, || {
                            $(let $arg = <$ty as $crate::engine::Param>::take(&ctx, $arg)?;)*
                            let value = if true $(&& $safe_point)? {
                                $crate::engine::with_editor(&ctx, |ed| body::$name(ed $(, $arg)*))?
                            } else {
                                $crate::engine::with_editor_unchecked(&ctx, |ed| body::$name(ed $(, $arg)*))?
                            };
                            $crate::engine::Ret::give(value, &ctx)
                        })
                    },
                )?;
                if !stringify!($vis).is_empty() {
                    api.set(stringify!($name), function.clone())?;
                }
                native.set(stringify!($name), function)?;
            )*
            Ok(())
        }

        /// Puts this module's natives on `native`, and the public ones on `api`.
        #[cfg(feature = "v8")]
        pub(crate) fn install<'s>(
            scope: &mut v8::PinScope<'s, '_>,
            native: v8::Local<'s, v8::Object>,
            api: v8::Local<'s, v8::Object>,
        ) {
            $(
                {
                    #[allow(unused_mut, unused_variables)]
                    fn callback<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue<'s, v8::Value>) {
                        $crate::engine::catching(scope, |scope| {
                            let mut at = 0;
                            $(let Ok($arg) = <$ty as $crate::engine::Param>::take(scope, &args, &mut at) else { return };)*
                            let safe_point = true $(&& $safe_point)?;
                            let Ok(value) = $crate::engine::with_editor(scope, safe_point, |ed| body::$name(ed $(, $arg)*)) else { return };
                            if let Ok(value) = $crate::engine::Ret::give(value, scope) {
                                rv.set(value);
                            }
                        });
                    }
                    $crate::engine::define(scope, native, api, stringify!($name), !stringify!($vis).is_empty(), callback);
                }
            )*
        }
    };
}
pub(crate) use natives;

/// An optional last argument, which may be left out.
pub(crate) struct Opt<T>(pub Option<T>);

/// The rest of the arguments.
pub(crate) struct Rest<T>(pub Vec<T>);

/// A prefix argument, as scripts write them: null, a number, "-" or [4].
pub(crate) struct Prefix(pub Option<PrefixArg>);

/// A command's argument as a script gives it: null or undefined is no
/// text, `[4]` is C-u's `(4)`, anything else its text, as `String(x)`
/// gives it.
pub(crate) struct ArgText(pub String);

/// Any value: the editor value it is, or none for one no editor value
/// holds, such as an object, for predicates that answer false for those.
pub(crate) struct Any(pub Option<EditorValue>);

/// An object of options, as `{ visit: true, beg: 0 }`: each property that
/// is an editor value, by name.
pub(crate) struct Fields(pub Vec<(String, EditorValue)>);

impl Fields {
    pub fn get(&self, name: &str) -> Option<&EditorValue> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, v)| v).filter(|v| !matches!(v, EditorValue::Null))
    }

    pub fn string(&self, name: &str) -> Option<String> {
        self.get(name).and_then(EditorValue::as_str).map(str::to_string)
    }

    pub fn number(&self, name: &str) -> Option<f64> {
        self.get(name).and_then(EditorValue::as_number)
    }

    /// Whether it is true, as `Boolean(x)`, false when left out.
    pub fn flag(&self, name: &str) -> bool {
        self.get(name).is_some_and(EditorValue::is_true)
    }

    pub fn strings(&self, name: &str) -> Option<Vec<String>> {
        match self.get(name)? {
            EditorValue::List(items) => Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
            _ => None,
        }
    }
}

/// Face attributes as scripts give them, as an object: see `face_attrs_from_js`.
pub(crate) struct FaceAttrValues(pub Vec<(String, EditorValue)>);

/// A face attribute's value, a plist given as an object: see `plist_or_value_to_js`.
pub(crate) struct PlistOrValue(pub EditorValue);

/// A window, as scripts give and get one: a `Window` object, or, while
/// packages move to the objects, its number (ADR 0069).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Win(pub u64);

/// A terminal, as scripts give and get one: a `Terminal` object, a frame,
/// or nothing for the selected frame's, as Emacs's TERMINAL arguments take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Trm(pub e8_core::TerminalId);

/// A frame, as scripts give and get one: a `Frame` object, or its number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Frm(pub u64);

/// A whole number at least 0, as a window's or frame's number.
fn id_of(n: f64) -> Option<u64> {
    (n >= 0.0 && n.fract() == 0.0).then_some(n as u64)
}

impl Win {
    pub fn from_value(value: &EditorValue) -> Option<Win> {
        match value {
            EditorValue::Window(id) => Some(Win(*id)),
            EditorValue::Number(n) => id_of(*n).filter(|id| *id < e8_core::FIRST_FRAME).map(Win),
            _ => None,
        }
    }
}

impl Trm {
    /// A terminal, a frame on it, or a number, as Emacs's TERMINAL
    /// arguments take any of them.
    pub fn from_value(value: &EditorValue) -> Option<Trm> {
        match value {
            EditorValue::Terminal(id) => Some(Trm(*id)),
            EditorValue::Frame(_) => Some(Trm(e8_core::THE_TERMINAL)),
            EditorValue::Number(n) => id_of(*n).map(Trm),
            _ => None,
        }
    }
}

impl Frm {
    pub fn from_value(value: &EditorValue) -> Option<Frm> {
        match value {
            EditorValue::Frame(id) => Some(Frm(*id)),
            EditorValue::Number(n) => id_of(*n).filter(|id| *id >= e8_core::FIRST_FRAME).map(Frm),
            _ => None,
        }
    }
}

/// A process, as scripts give one: a `Process` object, or, so packages
/// written before the objects keep working, its name (ADR 0070). Scripts
/// get a process as its object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Proc {
    Id(u64),
    Name(String),
}

impl Proc {
    pub fn from_value(value: &EditorValue) -> Option<Proc> {
        match value {
            EditorValue::Process(id) => Some(Proc::Id(*id)),
            EditorValue::Str(_) | EditorValue::Text(_) | EditorValue::Symbol(_) => value.as_str().map(|s| Proc::Name(s.to_string())),
            _ => None,
        }
    }

    /// The process's id: its object's, or that of the listed process with
    /// the name. A name no listed process has is an error, as get-process
    /// finding none.
    pub fn id(&self, ed: &e8_core::Editor) -> e8_core::Result<u64> {
        match self {
            Proc::Id(id) => Ok(*id),
            Proc::Name(name) => ed.process_named(name).ok_or_else(|| e8_core::Error::new(format!("Process {name} does not exist"))),
        }
    }

    /// The process's id if there is one: a name no listed process has gives none.
    pub fn id_if_any(&self, ed: &e8_core::Editor) -> Option<u64> {
        self.id(ed).ok()
    }

    /// The name of the listed process, for the editor's functions that take
    /// one: a process that has gone is not running.
    pub fn listed_name(&self, ed: &e8_core::Editor) -> e8_core::Result<String> {
        match self {
            Proc::Name(name) => Ok(name.clone()),
            Proc::Id(id) => ed.listed_process_name(*id).ok_or_else(|| {
                let name = ed.process_info(*id).map_or_else(|| format!("#<process {id}>"), |p| p.name);
                e8_core::Error::new(format!("Process {name} not running"))
            }),
        }
    }
}

/// A process given back to a script: its `Process` object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcObj(pub u64);

/// A position in a window, or none: see `posn_to_js`.
pub(crate) struct Posn(pub Option<e8_core::layout::Posn>);

/// An object a native returns, as plain data: its properties in order.
/// A name is usually a literal, and may be made as the object is, as a
/// frame's parameters are.
#[derive(Default)]
pub(crate) struct Record(pub Vec<(std::borrow::Cow<'static, str>, Field)>);

impl Record {
    pub fn new() -> Self {
        Record::default()
    }

    pub fn with(mut self, name: impl Into<std::borrow::Cow<'static, str>>, value: impl Into<Field>) -> Self {
        self.0.push((name.into(), value.into()));
        self
    }
}

/// A property of a [`Record`]: undefined, an editor value, text, a
/// number, a boolean, another record, or a list of these.
pub(crate) enum Field {
    Undefined,
    Value(EditorValue),
    Record(Record),
    List(Vec<Field>),
    FaceAttrs(Box<e8_core::FaceAttrs>),
}

impl<T: Into<Field>> From<Option<T>> for Field {
    fn from(v: Option<T>) -> Self {
        v.map_or(Field::Undefined, Into::into)
    }
}

impl<T: Into<Field>> From<Vec<T>> for Field {
    fn from(v: Vec<T>) -> Self {
        Field::List(v.into_iter().map(Into::into).collect())
    }
}

impl From<Record> for Field {
    fn from(r: Record) -> Self {
        Field::Record(r)
    }
}

impl From<EditorValue> for Field {
    fn from(v: EditorValue) -> Self {
        Field::Value(v)
    }
}

impl From<String> for Field {
    fn from(s: String) -> Self {
        Field::Value(EditorValue::Str(s))
    }
}

impl From<&str> for Field {
    fn from(s: &str) -> Self {
        Field::Value(EditorValue::Str(s.to_string()))
    }
}

impl From<bool> for Field {
    fn from(b: bool) -> Self {
        Field::Value(EditorValue::Bool(b))
    }
}

macro_rules! field_from_number {
    ($($t:ty),*) => {$(
        impl From<$t> for Field {
            fn from(n: $t) -> Self {
                Field::Value(EditorValue::Number(n as f64))
            }
        }
    )*};
}
field_from_number!(f64, f32, i64, i32, u64, u32, u8, usize);

/// Every table, in the order they are installed.
const TABLES: &[&[Native]] = &[
    editor::TABLE,
    variables::TABLE,
    processes::TABLE,
    text::TABLE,
    bidi::TABLE,
    treesit::TABLE,
    windows::TABLE,
    search::TABLE,
    files::TABLE,
    chartab::TABLE,
    images::TABLE,
];

/// Every native in the tables.
pub(crate) fn tables() -> impl Iterator<Item = &'static Native> {
    TABLES.iter().flat_map(|t| t.iter())
}

/// Puts every native in the tables on `native`, and the public ones on `api`.
#[cfg(feature = "quickjs")]
pub(crate) fn install<'js>(ctx: &rquickjs::Ctx<'js>, native: &rquickjs::Object<'js>, api: &rquickjs::Object<'js>) -> rquickjs::Result<()> {
    editor::install(ctx, native, api)?;
    variables::install(ctx, native, api)?;
    processes::install(ctx, native, api)?;
    text::install(ctx, native, api)?;
    bidi::install(ctx, native, api)?;
    treesit::install(ctx, native, api)?;
    windows::install(ctx, native, api)?;
    search::install(ctx, native, api)?;
    files::install(ctx, native, api)?;
    chartab::install(ctx, native, api)?;
    images::install(ctx, native, api)?;
    Ok(())
}

/// Puts every native in the tables on `native`, and the public ones on `api`.
#[cfg(feature = "v8")]
pub(crate) fn install<'s>(scope: &mut v8::PinScope<'s, '_>, native: v8::Local<'s, v8::Object>, api: v8::Local<'s, v8::Object>) {
    editor::install(scope, native, api);
    variables::install(scope, native, api);
    processes::install(scope, native, api);
    text::install(scope, native, api);
    bidi::install(scope, native, api);
    treesit::install(scope, native, api);
    windows::install(scope, native, api);
    search::install(scope, native, api);
    files::install(scope, native, api);
    chartab::install(scope, native, api);
    images::install(scope, native, api);
}

/// The declarations in `e8.d.ts` of the public natives.
pub(crate) fn declarations() -> String {
    let mut out = String::new();
    for native in tables().filter(|n| n.public) {
        out += &crate::types::js_doc(native.doc.trim_end(), "  ");
        let signature = native.ts.map(str::to_string).unwrap_or_else(|| signature(native));
        out += &format!("  function {}{signature};\n", native.name);
    }
    out
}

/// A signature from the Rust types: `(column: number): number`.
fn signature(native: &Native) -> String {
    let params: Vec<String> = native
        .params
        .iter()
        .map(|(name, ty)| {
            let ty = ty.replace(' ', "");
            // A window or frame is taken as its number too, while packages move to the objects.
            let like = |t: String| t.replace("Window", "WindowLike").replace("Frame", "FrameLike").replace("Process", "ProcessLike");
            if let Some(inner) = ty.strip_prefix("Opt<").and_then(|t| t.strip_suffix('>')) {
                format!("{name}?: {}", like(ts_type(inner)))
            } else if let Some(inner) = ty.strip_prefix("Rest<").and_then(|t| t.strip_suffix('>')) {
                format!("...{name}: {}[]", like(ts_type(inner)))
            } else {
                format!("{name}: {}", like(ts_type(&ty)))
            }
        })
        .collect();
    format!("({}): {}", params.join(", "), ts_type(&native.ret.replace(' ', "")))
}

/// The TypeScript type of a Rust type, without spaces.
fn ts_type(ty: &str) -> String {
    if let Some(inner) = ty.strip_prefix("Option<").and_then(|t| t.strip_suffix('>')) {
        return format!("{} | undefined", ts_type(inner));
    }
    if let Some(inner) = ty.strip_prefix("Vec<").and_then(|t| t.strip_suffix('>')) {
        let inner = ts_type(inner);
        return if inner.contains(' ') { format!("({inner})[]") } else { format!("{inner}[]") };
    }
    match ty {
        "()" => "void",
        "bool" => "boolean",
        "String" | "&'staticstr" | "char" => "string",
        "f64" | "i64" | "i32" | "u64" | "u32" | "u8" | "usize" => "number",
        "Prefix" => "PrefixArg",
        "Win" => "Window",
        "Frm" => "Frame",
        "Proc" | "ProcObj" => "Process",
        "Text" | "e8_core::Text" => "string | PropertizedString",
        _ => "Value",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A public native is `e8`'s function as it is, so prelude.js must
    /// not define it again, which would hide it.
    #[test]
    fn public_natives_are_not_defined_again() {
        for native in tables().filter(|n| n.public) {
            for form in [format!("\n    {}:", native.name), format!("\n    {}(", native.name)] {
                assert!(!crate::PRELUDE.contains(&form), "{} is a public native and defined in prelude.js too", native.name);
            }
        }
    }

    #[test]
    fn each_native_has_one_entry() {
        let mut names: Vec<&str> = tables().map(|n| n.name).collect();
        names.sort_unstable();
        let twice: Vec<_> = names.windows(2).filter(|w| w[0] == w[1]).map(|w| w[0]).collect();
        assert!(twice.is_empty(), "defined twice: {twice:?}");
    }

    #[test]
    fn signatures_follow_the_rust_types() {
        let native = Native { name: "f", doc: "", params: &[("a", "String"), ("b", "Opt<usize>")], ret: "Option<Vec<String>>", public: true, ts: None };
        assert_eq!(signature(&native), "(a: string, b?: number): string[] | undefined");
    }
}
