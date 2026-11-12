//! The value layer both engines share: editor values as script values and
//! back, written once over [`Scope`], the few operations it needs of an
//! engine, which each engine's module implements on its own scope (a
//! QuickJS context, a V8 handle scope). What differs between the engines,
//! holding a script's function and calling it, stays in theirs.

use e8_core::{Arg, Command, Editor, Error, FaceAttrs, ParamKind, PrefixArg, Result as EditorResult, Value as EditorValue};

use crate::{LOADING, camel_key, face_attribute_key};

/// A script's function an engine keeps for the editor to call later: a
/// command's run function, a parameter's prompt, collection or starting
/// input.
pub(crate) trait Held: 'static {
    /// Runs it as a command, with its arguments as scripts take them.
    fn call(&self, ed: &mut Editor, args: &[Arg]) -> EditorResult<()>;
    /// Calls it with the arguments read so far, for the names it returns.
    fn call_for_names(&self, ed: &mut Editor, args: &[Arg]) -> EditorResult<Vec<String>>;
    /// Calls it with the arguments read so far, for the text it returns.
    fn call_for_text(&self, ed: &mut Editor, args: &[Arg]) -> EditorResult<String>;
}

/// What the value layer needs of an engine: making its values, reading
/// them, and throwing. `Value` is a script value in the scope; `Error` is
/// how the engine's natives fail, a thrown exception.
pub(crate) trait Scope {
    type Value: Clone;
    type Error;
    type Held: Held;

    /// A script object the editor keeps as a value, freed when the value is.
    type Kept: 'static;

    /// A function kept for the editor to call, or `None` if it is not one.
    fn hold(&mut self, value: &Self::Value) -> Option<Self::Held>;
    /// Keeps a script value, an object, for the editor to give back.
    fn keep(&mut self, value: &Self::Value) -> Self::Kept;
    /// The value kept, as itself.
    fn restore(&mut self, kept: &Self::Kept) -> Result<Self::Value, Self::Error>;

    fn null(&mut self) -> Self::Value;
    fn undefined(&mut self) -> Self::Value;
    fn boolean(&mut self, b: bool) -> Self::Value;
    fn number(&mut self, n: f64) -> Self::Value;
    fn string(&mut self, s: &str) -> Result<Self::Value, Self::Error>;
    fn array(&mut self, items: Vec<Self::Value>) -> Result<Self::Value, Self::Error>;
    /// A new empty object.
    fn object(&mut self) -> Result<Self::Value, Self::Error>;
    fn set(&mut self, object: &Self::Value, key: &str, value: Self::Value) -> Result<(), Self::Error>;
    /// JavaScript's registered symbol of a name, `Symbol.for(name)`.
    fn symbol_for(&mut self, name: &str) -> Result<Self::Value, Self::Error>;
    /// Calls one of the prelude's functions on the global object.
    fn call_global(&mut self, name: &str, args: Vec<Self::Value>) -> Result<Self::Value, Self::Error>;
    /// An editor function as a script function: a script's own given back
    /// as itself, any other as a function that calls it.
    fn function_to_js(&mut self, function: &e8_core::Function) -> Result<Self::Value, Self::Error>;

    fn is_nullish(&mut self, value: &Self::Value) -> bool;
    fn as_bool(&mut self, value: &Self::Value) -> Option<bool>;
    fn as_number(&mut self, value: &Self::Value) -> Option<f64>;
    /// A string's text; `None` for anything else, a String object too.
    fn as_string(&mut self, value: &Self::Value) -> Option<String>;
    /// An array's items, or `None` if it is not an array.
    fn array_items(&mut self, value: &Self::Value) -> Result<Option<Vec<Self::Value>>, Self::Error>;
    /// A script function as an editor value, keeping the identity it had
    /// the last time it was one; `None` if it is not a function.
    fn function_from_js(&mut self, value: &Self::Value) -> Result<Option<EditorValue>, Self::Error>;
    /// A symbol's description: `None` if it is not a symbol, `Some(None)`
    /// for one without.
    fn symbol_description(&mut self, value: &Self::Value) -> Option<Option<String>>;
    /// Whether it is an object, arrays and functions included.
    fn is_object(&mut self, value: &Self::Value) -> bool;
    /// Whether it is a plain object: not an array, a function or a string.
    fn is_plain_object(&mut self, value: &Self::Value) -> bool;
    /// An object's property; `None` if it is undefined or not an object.
    fn get(&mut self, object: &Self::Value, key: &str) -> Result<Option<Self::Value>, Self::Error>;
    /// An object's own enumerable keys.
    fn keys(&mut self, object: &Self::Value) -> Result<Vec<String>, Self::Error>;
    /// Throws an editor error.
    fn throw(&mut self, e: &Error) -> Self::Error;
    /// Throws a TypeError.
    fn throw_type(&mut self, message: &str) -> Self::Error;
}

/// A variable's value as scripts see it: null, a boolean, a number, a
/// string or an array, and the prelude's objects for the editor's own.
pub(crate) fn value_to_js<S: Scope>(s: &mut S, value: &EditorValue) -> Result<S::Value, S::Error> {
    Ok(match value {
        EditorValue::Null => s.null(),
        EditorValue::Bool(b) => s.boolean(*b),
        EditorValue::Number(n) => s.number(*n),
        EditorValue::Str(text) => s.string(text)?,
        EditorValue::List(items) => {
            let items = items.iter().map(|item| value_to_js(s, item)).collect::<Result<Vec<_>, _>>()?;
            s.array(items)?
        }
        EditorValue::Function(function) => s.function_to_js(function)?,
        // A script's own object, given back as itself; one another engine
        // keeps is nothing this one can see.
        EditorValue::Object(object) => match object.origin().downcast_ref::<S::Kept>() {
            Some(kept) => s.restore(kept)?,
            None => s.undefined(),
        },
        // The prelude's object for the buffer, the same one each time.
        EditorValue::Buffer(id) => {
            let id = s.number(*id as f64);
            s.call_global("__e8Buffer", vec![id])?
        }
        // The prelude's object for the keymap, the same one each time.
        EditorValue::Keymap(id) => {
            let id = s.number(*id as f64);
            s.call_global("__e8Keymap", vec![id])?
        }
        // And for the char-table.
        EditorValue::CharTable(id) => {
            let id = s.number(*id as f64);
            s.call_global("__e8CharTable", vec![id])?
        }
        // The prelude's objects for tree-sitter parsers and nodes.
        EditorValue::Treesit(object) => {
            let (kind, raw): (&str, Vec<f64>) = match object {
                e8_core::treesitfns::TsObject::Parser { buffer, parser } => ("parser", vec![*buffer as f64, *parser as f64]),
                e8_core::treesitfns::TsObject::Node(r) => {
                    ("node", [r.buffer as f64, r.parser as f64, r.generation as f64].into_iter().chain(r.path.iter().map(|&i| i as f64)).collect())
                }
            };
            let kind = s.string(kind)?;
            let raw = raw.into_iter().map(|n| s.number(n)).collect();
            let raw = s.array(raw)?;
            s.call_global("__e8Treesit", vec![kind, raw])?
        }
        // The prelude's Font, holding its kind and its properties.
        EditorValue::Font(font) => {
            let plist = value_to_js(s, &EditorValue::List(font.to_plist()))?;
            let kind = s.string(font.kind.name())?;
            s.call_global("__e8Font", vec![kind, plist])?
        }
        // The prelude's Window and Frame for the id, the same object each time.
        EditorValue::Window(id) => {
            let id = s.number(*id as f64);
            s.call_global("__e8Window", vec![id])?
        }
        EditorValue::Frame(id) => {
            let id = s.number(*id as f64);
            s.call_global("__e8Frame", vec![id])?
        }
        // The prelude's Process for the id, the same object each time.
        EditorValue::Process(id) => {
            let id = s.number(*id as f64);
            s.call_global("__e8Process", vec![id])?
        }
        // The prelude's Marker for the id, the one the value was made from.
        EditorValue::Marker(id) => {
            let id = s.number(*id as f64);
            s.call_global("__e8Marker", vec![id])?
        }
        // A symbol is JavaScript's registered symbol of its name, interned as Emacs's are.
        EditorValue::Symbol(name) => s.symbol_for(name)?,
        // The prelude's PropertizedString, with its runs as [start, end, properties].
        EditorValue::Text(text) => {
            let mut runs = Vec::with_capacity(text.props.len());
            for (range, props) in &text.props {
                let object = props_to_js(s, props)?;
                let run = vec![s.number(range.start as f64), s.number(range.end as f64), object];
                runs.push(s.array(run)?);
            }
            let runs = s.array(runs)?;
            let string = s.string(&text.string)?;
            s.call_global("__e8Text", vec![string, runs])?
        }
    })
}

/// A script value as an editor value, throwing a TypeError if it is not
/// one, a BigInt.
pub(crate) fn value_from_js<S: Scope>(s: &mut S, value: S::Value) -> Result<EditorValue, S::Error> {
    match convert_from_js(s, value)? {
        Some(value) => Ok(value),
        None => Err(s.throw_type("A variable cannot hold a BigInt")),
    }
}

/// A number a property holds, if it holds one.
fn number_property<S: Scope>(s: &mut S, object: &S::Value, key: &str) -> Result<Option<f64>, S::Error> {
    Ok(s.get(object, key)?.and_then(|v| s.as_number(&v)))
}

/// The numbers an array property holds, if it holds an array of them.
fn numbers_property<S: Scope>(s: &mut S, object: &S::Value, key: &str) -> Result<Option<Vec<f64>>, S::Error> {
    let Some(list) = s.get(object, key)? else { return Ok(None) };
    let Some(items) = s.array_items(&list)? else { return Ok(None) };
    Ok(items.iter().map(|v| s.as_number(v)).collect())
}

/// A script value as an editor value: a plain object, or any other the
/// editor has no value of its own for, kept as itself, as a Lisp record.
/// `None` for what no value can hold, a BigInt.
pub(crate) fn convert_from_js<S: Scope>(s: &mut S, value: S::Value) -> Result<Option<EditorValue>, S::Error> {
    if s.is_nullish(&value) {
        return Ok(Some(EditorValue::Null));
    }
    if let Some(b) = s.as_bool(&value) {
        return Ok(Some(EditorValue::Bool(b)));
    }
    if let Some(n) = s.as_number(&value) {
        return Ok(Some(EditorValue::Number(n)));
    }
    if let Some(text) = s.as_string(&value) {
        return Ok(Some(EditorValue::Str(text)));
    }
    if let Some(list) = s.array_items(&value)? {
        let mut items = Vec::with_capacity(list.len());
        for item in list {
            match convert_from_js(s, item)? {
                Some(item) => items.push(item),
                None => return Ok(None),
            }
        }
        return Ok(Some(EditorValue::List(items)));
    }
    if let Some(function) = s.function_from_js(&value)? {
        return Ok(Some(function));
    }
    if let Some(description) = s.symbol_description(&value) {
        return Ok(description.map(EditorValue::Symbol));
    }
    if !s.is_object(&value) {
        return Ok(None);
    }
    let object = value;
    if let Some(id) = number_property(s, &object, "__e8BufferId")? {
        return Ok(Some(EditorValue::Buffer(id as u64)));
    }
    if let Some(id) = number_property(s, &object, "__e8WindowId")? {
        return Ok(Some(EditorValue::Window(id as u64)));
    }
    if let Some(id) = number_property(s, &object, "__e8FrameId")? {
        return Ok(Some(EditorValue::Frame(id as u64)));
    }
    if let Some(id) = number_property(s, &object, "__e8ProcessId")? {
        return Ok(Some(EditorValue::Process(id as u64)));
    }
    if let Some(id) = number_property(s, &object, "__e8KeymapId")? {
        return Ok(Some(EditorValue::Keymap(id as usize)));
    }
    if let Some(raw) = numbers_property(s, &object, "__e8TreesitParser")?
        && raw.len() == 2
    {
        return Ok(Some(EditorValue::Treesit(e8_core::treesitfns::TsObject::Parser { buffer: raw[0] as u64, parser: raw[1] as u64 })));
    }
    if let Some(raw) = numbers_property(s, &object, "__e8TreesitNode")?
        && raw.len() >= 3
    {
        let r = e8_core::treesitfns::NodeRef {
            buffer: raw[0] as u64,
            parser: raw[1] as u64,
            generation: raw[2] as u64,
            path: raw[3..].iter().map(|&i| i as u32).collect(),
        };
        return Ok(Some(EditorValue::Treesit(e8_core::treesitfns::TsObject::Node(r))));
    }
    if let Some(kind) = s.get(&object, "__e8FontKind")?.and_then(|v| s.as_string(&v))
        && let Some(kind) = e8_core::FontKind::from_name(&kind)
    {
        let plist = match s.get(&object, "__e8FontPlist")? {
            Some(plist) => match convert_from_js(s, plist)? {
                Some(EditorValue::List(items)) => items,
                _ => Vec::new(),
            },
            None => Vec::new(),
        };
        let font = e8_core::Font::from_plist(kind, &plist).map_err(|e| s.throw(&e))?;
        return Ok(Some(EditorValue::Font(Box::new(font))));
    }
    // A marker the editor now holds, which collecting the script's object
    // must no longer delete, as a Lisp marker lives while a variable has it.
    if let Some(id) = number_property(s, &object, "__e8MarkerId")? {
        s.call_global("__e8KeepMarker", vec![object])?;
        return Ok(Some(EditorValue::Marker(id as u64)));
    }
    if let Some(id) = number_property(s, &object, "__e8CharTableId")? {
        return Ok(Some(EditorValue::CharTable(id as u64)));
    }
    if s.get(&object, "__e8Text")?.and_then(|v| s.as_bool(&v)) == Some(true) {
        let string = s.get(&object, "string")?.and_then(|v| s.as_string(&v)).unwrap_or_default();
        let runs = s.get(&object, "properties")?;
        let Some(runs) = (match runs {
            Some(runs) => s.array_items(&runs)?,
            None => None,
        }) else {
            return Err(s.throw(&Error::new("A propertized string's properties are a list")));
        };
        let mut props = Vec::new();
        for run in runs {
            let Some(run) = s.array_items(&run)? else { continue };
            let at = |s: &mut S, k: usize| run.get(k).and_then(|v| s.as_number(v)).unwrap_or(0.0);
            let (start, end) = (at(s, 0), at(s, 1));
            let Some(names) = run.get(2).filter(|v| s.is_object(v)).cloned() else { continue };
            let mut map = e8_core::Props::new();
            for key in s.keys(&names)? {
                let v = s.get(&names, &key)?.unwrap_or_else(|| s.undefined());
                match convert_from_js(s, v)? {
                    Some(v) => {
                        map.insert(key, v);
                    }
                    None => return Ok(None),
                }
            }
            // Counted in characters, and within the string.
            let n = string.chars().count();
            let (start, end) = ((start.max(0.0) as usize).min(n), (end.max(0.0) as usize).min(n));
            if end > start && !map.is_empty() {
                props.push((start..end, map));
            }
        }
        return Ok(Some(EditorValue::Text(e8_core::Text { string, props })));
    }
    // The prelude's identity for the object, so one object is one value, `eq` to itself.
    let id = s.call_global("__e8ObjectId", vec![object.clone()])?;
    let id = s.as_number(&id).unwrap_or(0.0) as u64;
    let kept = s.keep(&object);
    Ok(Some(EditorValue::Object(e8_core::ScriptObject::new(id, std::rc::Rc::new(kept)))))
}

/// A string or propertized string from a script, as text to insert.
pub(crate) fn text_from_js<S: Scope>(s: &mut S, value: S::Value) -> Result<e8_core::Text, S::Error> {
    Ok(match value_from_js(s, value)? {
        EditorValue::Text(text) => text,
        other => e8_core::Text { string: other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string()), props: Vec::new() },
    })
}

/// A match as a script sees it: `{ start, end, groups }`.
pub(crate) fn match_to_js<S: Scope>(s: &mut S, m: &e8_core::Match) -> Result<S::Value, S::Error> {
    let object = s.object()?;
    let start = s.number(m.start as f64);
    s.set(&object, "start", start)?;
    let end = s.number(m.end as f64);
    s.set(&object, "end", end)?;
    let mut groups = Vec::with_capacity(m.groups.len());
    for g in &m.groups {
        groups.push(match g {
            Some((start, end)) => {
                let pair = vec![s.number(*start as f64), s.number(*end as f64)];
                s.array(pair)?
            }
            None => s.undefined(),
        });
    }
    let groups = s.array(groups)?;
    s.set(&object, "groups", groups)?;
    Ok(object)
}

/// Text properties as an object of their values.
pub(crate) fn props_to_js<S: Scope>(s: &mut S, props: &e8_core::Props) -> Result<S::Value, S::Error> {
    let object = s.object()?;
    for (name, value) in props {
        let value = value_to_js(s, value)?;
        s.set(&object, name, value)?;
    }
    Ok(object)
}

/// Face attributes from an object such as `{ foreground: "accent", weight:
/// "bold", underline: { color: "red", style: "wave" } }`, each value as
/// Emacs gives it, an object standing for a plist.
pub(crate) fn face_attrs_from_js<S: Scope>(s: &mut S, object: &S::Value) -> Result<FaceAttrs, S::Error> {
    let mut attrs = FaceAttrs::default();
    for (key, value) in face_attr_values_from_js(s, object)? {
        attrs.set(&key, &value);
    }
    Ok(attrs)
}

/// Each attribute in such an object, as its Emacs name and value.
pub(crate) fn face_attr_values_from_js<S: Scope>(s: &mut S, object: &S::Value) -> Result<Vec<(String, EditorValue)>, S::Error> {
    let mut values = Vec::new();
    for key in s.keys(object)? {
        let Some(value) = s.get(object, &key)? else { continue };
        let value = if s.is_plain_object(&value) {
            let mut plist = Vec::new();
            for k in s.keys(&value)? {
                let v = s.get(&value, &k)?.unwrap_or_else(|| s.undefined());
                plist.push(EditorValue::Symbol(face_attribute_key(&k)));
                plist.push(value_from_js(s, v)?);
            }
            EditorValue::List(plist)
        } else {
            value_from_js(s, value)?
        };
        values.push((face_attribute_key(&key), value));
    }
    Ok(values)
}

/// A place in a window as scripts see it, as Emacs's posn: the window,
/// the buffer position, x and y from the top left of the text area, and
/// the column and row in default characters; undefined for none.
pub(crate) fn posn_to_js<S: Scope>(s: &mut S, posn: Option<e8_core::layout::Posn>) -> Result<S::Value, S::Error> {
    let Some(posn) = posn else { return Ok(s.undefined()) };
    let object = s.object()?;
    let window = value_to_js(s, &EditorValue::Window(posn.window))?;
    s.set(&object, "window", window)?;
    let fields = [
        ("point", posn.point as f64),
        ("x", posn.x as f64),
        ("y", posn.y as f64),
        ("col", posn.col as f64),
        ("row", posn.row as f64),
    ];
    for (key, n) in fields {
        let n = s.number(n);
        s.set(&object, key, n)?;
    }
    Ok(object)
}

/// Face attributes as scripts see them: an object of the attributes that
/// are set, keyed as scripts give them (`weight`, `inverseVideo`), each
/// value as Emacs's `face-attribute` gives it, with `bold` and `italic`
/// added where the weight and slant say so.
pub(crate) fn face_attrs_to_js<S: Scope>(s: &mut S, attrs: &FaceAttrs) -> Result<S::Value, S::Error> {
    let object = s.object()?;
    let plist = attrs.to_plist();
    for pair in plist.chunks(2) {
        let [key, value] = pair else { break };
        let Some(key) = key.as_str() else { continue };
        let value = plist_or_value_to_js(s, value)?;
        s.set(&object, &camel_key(key), value)?;
    }
    for (set, key) in [(attrs.is_bold(), "bold"), (attrs.is_italic(), "italic")] {
        if set {
            let t = s.boolean(true);
            s.set(&object, key, t)?;
        }
    }
    Ok(object)
}

/// A face attribute's value as scripts see it: a plist such as an
/// underline's `(:color "red" :style wave)` as an object, `{ color: "red",
/// style: "wave" }`, anything else as it is.
pub(crate) fn plist_or_value_to_js<S: Scope>(s: &mut S, value: &EditorValue) -> Result<S::Value, S::Error> {
    let EditorValue::List(items) = value else { return value_to_js(s, value) };
    if !items.first().and_then(EditorValue::as_str).is_some_and(|k| k.starts_with(':')) {
        return value_to_js(s, value);
    }
    let object = s.object()?;
    for pair in items.chunks(2) {
        let [key, v] = pair else { break };
        let Some(key) = key.as_str() else { continue };
        let v = value_to_js(s, v)?;
        s.set(&object, &camel_key(key), v)?;
    }
    Ok(object)
}

/// A prefix argument as scripts see it, in Emacs's forms: null, a number,
/// "-", or a one-element array such as [4] for C-u.
pub(crate) fn prefix_to_js<S: Scope>(s: &mut S, arg: Option<PrefixArg>) -> Result<S::Value, S::Error> {
    Ok(match arg {
        None => s.null(),
        Some(PrefixArg::Number(n)) => s.number(n as f64),
        Some(PrefixArg::Minus) => s.string("-")?,
        Some(PrefixArg::Universal(n)) => {
            let n = vec![s.number(n as f64)];
            s.array(n)?
        }
    })
}

/// A prefix argument from a script, in those forms.
pub(crate) fn prefix_from_js<S: Scope>(s: &mut S, value: S::Value) -> Result<Option<PrefixArg>, S::Error> {
    if s.is_nullish(&value) {
        return Ok(None);
    }
    if let Some(n) = s.as_number(&value) {
        return Ok(Some(PrefixArg::Number(n as i64)));
    }
    if s.as_string(&value).as_deref() == Some("-") {
        return Ok(Some(PrefixArg::Minus));
    }
    if let Some(items) = s.array_items(&value)?
        && let [n] = items.as_slice()
        && let Some(n) = s.as_number(n)
    {
        return Ok(Some(PrefixArg::Universal(n as i64)));
    }
    Err(s.throw_type("A prefix argument is null, a number, \"-\" or [n]"))
}

/// A command from what `e8.defineCommand` is given: its name and
/// documentation, its parameters, each `{ name, kind, prompt, collection,
/// requireMatch, initial, history }` with functions for what is worked out
/// from the arguments before it, its run function, and whether it selects
/// as it moves with shift.
pub(crate) fn command_from_js<S: Scope>(s: &mut S, [name, doc, params, run, shift_select]: [S::Value; 5]) -> Result<Command, S::Error> {
    let name = s.as_string(&name).unwrap_or_default();
    let doc = s.as_string(&doc).unwrap_or_default();
    let Some(params) = s.array_items(&params)? else { return Err(s.throw(&Error::new("A command's params are a list"))) };
    let Some(run) = s.hold(&run) else { return Err(s.throw(&Error::new("A command needs a run function"))) };
    let mut command = Command::new(&name, &doc, move |ed, args| run.call(ed, args));
    command.shift_select = s.as_bool(&shift_select) == Some(true);
    command.source = LOADING.with_borrow(|files| files.last().cloned());
    for param in params {
        if !s.is_plain_object(&param) {
            return Err(s.throw(&Error::new("A parameter is an object")));
        }
        let field = |s: &mut S, key: &str| -> Result<Option<S::Value>, S::Error> { Ok(s.get(&param, key)?.filter(|v| !s.is_nullish(v))) };
        let param_name = field(s, "name")?.and_then(|v| s.as_string(&v)).unwrap_or_default();
        let kind = field(s, "kind")?.and_then(|v| s.as_string(&v)).unwrap_or_default();
        let prompt_value = field(s, "prompt")?;
        let prompt_fn = prompt_value.as_ref().and_then(|v| s.hold(v));
        let prompt = match (&prompt_fn, &prompt_value) {
            (None, Some(v)) => s.as_string(v).unwrap_or_default(),
            _ => String::new(),
        };
        let Some(kind) = ParamKind::from_name(&kind) else {
            let kinds: Vec<&str> = ParamKind::ALL.iter().map(ParamKind::name).collect();
            return Err(s.throw_type(&format!("Unknown parameter kind {kind:?}; use one of {}", kinds.join(", "))));
        };
        command = command.param(&param_name, kind, &prompt);
        if let Some(f) = prompt_fn {
            command = command.prompt_with(move |ed, args| f.call_for_text(ed, args));
        }
        if let Some(f) = field(s, "collection")?.and_then(|v| s.hold(&v)) {
            let require_match = field(s, "requireMatch")?.and_then(|v| s.as_bool(&v)) == Some(true);
            command = command.collection(require_match, move |ed, args| f.call_for_names(ed, args));
        }
        if let Some(initial) = field(s, "initial")? {
            if let Some(f) = s.hold(&initial) {
                command = command.initial_with(move |ed, args| f.call_for_text(ed, args));
            } else if let Some(text) = s.as_string(&initial) {
                command = command.initial_with(move |_, _| Ok(text.clone()));
            }
        }
        if let Some(history) = field(s, "history")?.and_then(|v| s.as_string(&v)) {
            command = command.history(&history);
        }
    }
    Ok(command)
}
