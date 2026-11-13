//! The natives' binding on QuickJS: how each Rust type a native takes or
//! returns converts from and to rquickjs's values.

use e8_core::Value as EditorValue;
use rquickjs::{Coerced, Ctx, FromJs, IntoJs, Value};

use crate::natives::{Any, ArgText, FaceAttrValues, Field, Fields, Frm, Trm, Opt, PlistOrValue, Posn, Prefix, Proc, ProcObj, Record, Rest, Win};

/// A value a native takes, converted from the script's.
pub(crate) trait Conv: Sized {
    type Js<'js>: FromJs<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self>;
}

/// A parameter of a native: a value, or an optional or rest argument.
pub(crate) trait Param: Sized {
    type Js<'js>: rquickjs::function::FromParam<'js>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self>;
}

/// An argument left out is undefined, as JavaScript passes it to a
/// function of its own, rather than an error.
impl<T: Conv> Param for T {
    type Js<'js> = rquickjs::function::Opt<Value<'js>>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        let value = js.0.unwrap_or_else(|| Value::new_undefined(ctx.clone()));
        T::conv(ctx, T::Js::from_js(ctx, value)?)
    }
}

impl<T: Conv> Param for Opt<T> {
    type Js<'js> = rquickjs::function::Opt<T::Js<'js>>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.0.map(|v| T::conv(ctx, v)).transpose().map(Opt)
    }
}

impl<T: Conv> Param for Rest<T> {
    type Js<'js> = rquickjs::function::Rest<T::Js<'js>>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.0.into_iter().map(|v| T::conv(ctx, v)).collect::<rquickjs::Result<_>>().map(Rest)
    }
}

/// Text is coerced, as `String(x)` does; so is a boolean, as `Boolean(x)`.
impl Conv for String {
    type Js<'js> = Coerced<String>;
    fn conv<'js>(_: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(js.0)
    }
}

impl Conv for bool {
    type Js<'js> = Coerced<bool>;
    fn conv<'js>(_: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(js.0)
    }
}

macro_rules! conv_as_is {
    ($($t:ty),*) => {$(
        impl Conv for $t {
            type Js<'js> = $t;
            fn conv<'js>(_: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
                Ok(js)
            }
        }
    )*};
}
conv_as_is!(f64, i64, i32, u64, u32, u8, usize);

/// Null or undefined is `None`.
impl<T: Conv> Conv for Option<T> {
    type Js<'js> = Option<T::Js<'js>>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.map(|v| T::conv(ctx, v)).transpose()
    }
}

impl<T: Conv> Conv for Vec<T> {
    type Js<'js> = Vec<T::Js<'js>>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.into_iter().map(|v| T::conv(ctx, v)).collect()
    }
}

impl Conv for EditorValue {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        super::value_from_js(ctx, js)
    }
}

/// A Window, or a window's number.
impl Conv for Win {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        let value = super::value_from_js(ctx, js)?;
        Win::from_value(&value).ok_or_else(|| rquickjs::Exception::throw_type(ctx, &format!("Not a window: {value}")))
    }
}

/// A Frame, or a frame's number.
impl Conv for Trm {
    fn conv<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<Self> {
        let value = super::value_from_js(ctx, value)?;
        match Trm::from_value(&value) {
            Some(t) => Ok(t),
            None => Err(type_error(ctx, &format!("Not a terminal: {value}"))),
        }
    }
}

impl Conv for Frm {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        let value = super::value_from_js(ctx, js)?;
        Frm::from_value(&value).ok_or_else(|| rquickjs::Exception::throw_type(ctx, &format!("Not a frame: {value}")))
    }
}

/// A Process, or a process's name.
impl Conv for Proc {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        let value = super::value_from_js(ctx, js)?;
        Proc::from_value(&value).ok_or_else(|| rquickjs::Exception::throw_type(ctx, &format!("Not a process: {value}")))
    }
}

impl Ret for ProcObj {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::value_to_js(ctx, &EditorValue::Process(self.0))
    }
}

impl Ret for Win {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::value_to_js(ctx, &EditorValue::Window(self.0))
    }
}

impl Ret for Frm {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::value_to_js(ctx, &EditorValue::Frame(self.0))
    }
}

impl Ret for Trm {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::value_to_js(ctx, &EditorValue::Terminal(self.0))
    }
}

/// A string or propertized string.
impl Conv for e8_core::Text {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        super::text_from_js(ctx, js)
    }
}

/// A script's function, as the editor holds one: the same function each time.
impl Conv for e8_core::Function {
    type Js<'js> = rquickjs::Function<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        match super::function_from_js(ctx, js)? {
            EditorValue::Function(function) => Ok(function),
            _ => unreachable!("a function converts to one"),
        }
    }
}

impl Conv for Any {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(Any(super::value_from_js(ctx, js).ok()))
    }
}

impl Conv for ArgText {
    type Js<'js> = Value<'js>;
    fn conv<'js>(_: &Ctx<'js>, value: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(ArgText(if value.is_null() || value.is_undefined() {
            String::new()
        } else if let Some(list) = value.as_array() {
            format!("({})", list.get::<Coerced<String>>(0)?.0)
        } else {
            value.get::<Coerced<String>>()?.0
        }))
    }
}

/// Each own property that is an editor value; others, such as objects, are left out.
impl Conv for Fields {
    type Js<'js> = rquickjs::Object<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, object: Self::Js<'js>) -> rquickjs::Result<Self> {
        let mut fields = Vec::new();
        for entry in object.props::<String, Value>() {
            let (name, value) = entry?;
            if let Some(value) = super::convert_from_js(ctx, value)?.filter(|v| !matches!(v, e8_core::Value::Object(_))) {
                fields.push((name, value));
            }
        }
        Ok(Fields(fields))
    }
}

impl Conv for FaceAttrValues {
    type Js<'js> = rquickjs::Object<'js>;
    fn conv<'js>(_: &Ctx<'js>, object: Self::Js<'js>) -> rquickjs::Result<Self> {
        super::face_attr_values_from_js(&object).map(FaceAttrValues)
    }
}

impl Conv for e8_core::FaceAttrs {
    type Js<'js> = rquickjs::Object<'js>;
    fn conv<'js>(_: &Ctx<'js>, object: Self::Js<'js>) -> rquickjs::Result<Self> {
        super::face_attrs_from_js(&object)
    }
}

impl Conv for Prefix {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        super::prefix_from_js(ctx, js).map(Prefix)
    }
}

/// What a native returns, converted to the script's value.
pub(crate) trait Ret {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>>;
}

macro_rules! ret_as_is {
    ($($t:ty),*) => {$(
        impl Ret for $t {
            fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
                self.into_js(ctx)
            }
        }
    )*};
}
ret_as_is!((), bool, String, &'static str, f64, i64, i32, u64, u32, u8, usize, char);

/// `None` is undefined, as Emacs's nil is to scripts.
impl<T: Ret> Ret for Option<T> {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        match self {
            Some(v) => v.give(ctx),
            None => Ok(Value::new_undefined(ctx.clone())),
        }
    }
}

impl<T: Ret> Ret for Vec<T> {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        let list = rquickjs::Array::new(ctx.clone())?;
        for (i, item) in self.into_iter().enumerate() {
            list.set(i, item.give(ctx)?)?;
        }
        Ok(list.into_value())
    }
}

impl<A: Ret, B: Ret> Ret for (A, B) {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        vec![self.0.give(ctx)?, self.1.give(ctx)?].into_js(ctx)
    }
}

impl<A: Ret, B: Ret, C: Ret> Ret for (A, B, C) {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        vec![self.0.give(ctx)?, self.1.give(ctx)?, self.2.give(ctx)?].into_js(ctx)
    }
}

impl Ret for EditorValue {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::value_to_js(ctx, &self)
    }
}

impl Ret for Record {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        let object = rquickjs::Object::new(ctx.clone())?;
        for (name, field) in self.0 {
            object.set(name.as_ref(), field.give(ctx)?)?;
        }
        Ok(object.into_value())
    }
}

impl Ret for Field {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        match self {
            Field::Undefined => Ok(Value::new_undefined(ctx.clone())),
            Field::Value(v) => v.give(ctx),
            Field::Record(r) => r.give(ctx),
            Field::List(items) => items.give(ctx),
            Field::FaceAttrs(attrs) => attrs.give(ctx),
        }
    }
}

impl<T: Ret> Ret for Box<T> {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        (*self).give(ctx)
    }
}

impl Ret for e8_core::FaceAttrs {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::face_attrs_to_js(ctx, &self)
    }
}

impl Ret for PlistOrValue {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::plist_or_value_to_js(ctx, &self.0)
    }
}

impl Ret for Posn {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::posn_to_js(ctx, self.0)
    }
}

impl Ret for e8_core::Match {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::match_to_js(ctx, &self)
    }
}

/// Text properties, as an object of each property's value.
impl Ret for e8_core::Props {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::props_to_js(ctx, &self)
    }
}

impl Ret for Prefix {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        super::prefix_to_js(ctx, self.0)
    }
}

