//! The natives' binding on V8: how each Rust type a native takes or
//! returns converts from and to V8's values. The same types as QuickJS's
//! binding, converted the same way.

use e8_core::Value as EditorValue;

use super::{Js, Thrown, number, string};
use crate::natives::{Any, ArgText, FaceAttrValues, Field, Fields, Frm, Opt, PlistOrValue, Posn, Prefix, Record, Rest, Win};

type Scope<'s, 'i> = v8::PinScope<'s, 'i>;
type Value<'s> = v8::Local<'s, v8::Value>;

/// A value a native takes, converted from the script's.
pub(crate) trait Conv: Sized {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown>;
}

/// A parameter of a native: a value, or an optional or rest argument,
/// taken from the arguments at `at`. An argument left out is undefined.
pub(crate) trait Param: Sized {
    fn take<'s>(scope: &mut Scope<'s, '_>, args: &v8::FunctionCallbackArguments<'s>, at: &mut i32) -> Result<Self, Thrown>;
}

impl<T: Conv> Param for T {
    fn take<'s>(scope: &mut Scope<'s, '_>, args: &v8::FunctionCallbackArguments<'s>, at: &mut i32) -> Result<Self, Thrown> {
        let value = args.get(*at);
        *at += 1;
        T::conv(scope, value)
    }
}

impl<T: Conv> Param for Opt<T> {
    fn take<'s>(scope: &mut Scope<'s, '_>, args: &v8::FunctionCallbackArguments<'s>, at: &mut i32) -> Result<Self, Thrown> {
        let i = *at;
        *at += 1;
        if i >= args.length() {
            return Ok(Opt(None));
        }
        T::conv(scope, args.get(i)).map(|v| Opt(Some(v)))
    }
}

impl<T: Conv> Param for Rest<T> {
    fn take<'s>(scope: &mut Scope<'s, '_>, args: &v8::FunctionCallbackArguments<'s>, at: &mut i32) -> Result<Self, Thrown> {
        let mut rest = Vec::new();
        while *at < args.length() {
            rest.push(T::conv(scope, args.get(*at))?);
            *at += 1;
        }
        Ok(Rest(rest))
    }
}

fn type_error(scope: &mut Scope<'_, '_>, message: &str) -> Thrown {
    let message = string(scope, message);
    let error = v8::Exception::type_error(scope, message);
    scope.throw_exception(error);
    Thrown
}

/// Text is coerced, as `String(x)` does.
impl Conv for String {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        if value.is_string() {
            return Ok(value.to_rust_string_lossy(scope));
        }
        let text = value.to_string(scope).ok_or(Thrown)?;
        Ok(text.to_rust_string_lossy(scope))
    }
}

/// So is a boolean, as `Boolean(x)`.
impl Conv for bool {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        Ok(value.boolean_value(scope))
    }
}

impl Conv for f64 {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        if !value.is_number() {
            return Err(type_error(scope, "Expected a number for f64"));
        }
        Ok(value.number_value(scope).unwrap_or(f64::NAN))
    }
}

/// An integer outside the type's range is refused, as QuickJS's binding
/// refuses it, rather than saturated: a position below 0 is an error on
/// both engines.
macro_rules! conv_integer {
    ($($t:ty),*) => {$(
        impl Conv for $t {
            fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
                if !value.is_number() {
                    let message = format!("Expected a number for {}", stringify!($t));
                    return Err(type_error(scope, &message));
                }
                let n = value.number_value(scope).unwrap_or(f64::NAN);
                let out = if n < <$t>::MIN as f64 { Some("Underflow") } else if n > <$t>::MAX as f64 { Some("Overflow") } else { None };
                if let Some(why) = out {
                    let message = format!("Error converting from js 'f64' into type '{}': {why}", stringify!($t));
                    return Err(type_error(scope, &message));
                }
                Ok(n as $t)
            }
        }
    )*};
}
conv_integer!(i64, i32, u64, u32, u8, usize);

/// Null or undefined is `None`.
impl<T: Conv> Conv for Option<T> {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        if value.is_null_or_undefined() { Ok(None) } else { T::conv(scope, value).map(Some) }
    }
}

impl<T: Conv> Conv for Vec<T> {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        let Ok(list) = v8::Local::<v8::Array>::try_from(value) else {
            return Err(type_error(scope, "Expected an array"));
        };
        let mut items = Vec::with_capacity(list.length() as usize);
        for i in 0..list.length() {
            let item = list.get_index(scope, i).ok_or(Thrown)?;
            items.push(T::conv(scope, item)?);
        }
        Ok(items)
    }
}

impl Conv for EditorValue {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        super::value_from_js(scope, value)
    }
}

/// A Window, or a window's number.
impl Conv for Win {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        let value = super::value_from_js(scope, value)?;
        match Win::from_value(&value) {
            Some(w) => Ok(w),
            None => Err(type_error(scope, &format!("Not a window: {value}"))),
        }
    }
}

/// A Frame, or a frame's number.
impl Conv for Frm {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        let value = super::value_from_js(scope, value)?;
        match Frm::from_value(&value) {
            Some(f) => Ok(f),
            None => Err(type_error(scope, &format!("Not a frame: {value}"))),
        }
    }
}

impl Ret for Win {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::value_to_js(scope, &EditorValue::Window(self.0))
    }
}

impl Ret for Frm {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::value_to_js(scope, &EditorValue::Frame(self.0))
    }
}

/// A string or propertized string.
impl Conv for e8_core::Text {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        super::text_from_js(scope, value)
    }
}

/// A script's function, as the editor holds one: the same function each time.
impl Conv for e8_core::Function {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        let Ok(f) = v8::Local::<v8::Function>::try_from(value) else {
            return Err(type_error(scope, "Expected a function"));
        };
        match super::function_from_js(scope, f)? {
            EditorValue::Function(function) => Ok(function),
            _ => unreachable!("a function converts to one"),
        }
    }
}

impl Conv for Any {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        // A value no editor value holds answers false, rather than throwing.
        v8::tc_scope!(let tc, scope);
        let converted = super::value_from_js(tc, value).ok();
        if tc.has_caught() && !tc.has_terminated() {
            tc.reset();
        }
        Ok(Any(converted))
    }
}

impl Conv for ArgText {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        Ok(ArgText(if value.is_null_or_undefined() {
            String::new()
        } else if let Ok(list) = v8::Local::<v8::Array>::try_from(value) {
            let first = list.get_index(scope, 0).ok_or(Thrown)?;
            format!("({})", String::conv(scope, first)?)
        } else {
            String::conv(scope, value)?
        }))
    }
}

/// Each own property that is an editor value; others, such as objects, are left out.
impl Conv for Fields {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        let Ok(object) = v8::Local::<v8::Object>::try_from(value) else {
            return Err(type_error(scope, "Expected an object of options"));
        };
        let mut fields = Vec::new();
        for name in super::keys(scope, object) {
            let value = super::get(scope, object, &name).ok_or(Thrown)?;
            if let Some(value) = super::convert_from_js(scope, value)?.filter(|v| !matches!(v, e8_core::Value::Object(_))) {
                fields.push((name, value));
            }
        }
        Ok(Fields(fields))
    }
}

impl Conv for FaceAttrValues {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        let Ok(object) = v8::Local::<v8::Object>::try_from(value) else {
            return Err(type_error(scope, "Expected an object of face attributes"));
        };
        super::face_attr_values_from_js(scope, object).map(FaceAttrValues)
    }
}

impl Conv for e8_core::FaceAttrs {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        let Ok(object) = v8::Local::<v8::Object>::try_from(value) else {
            return Err(type_error(scope, "Expected an object of face attributes"));
        };
        super::face_attrs_from_js(scope, object)
    }
}

impl Conv for Prefix {
    fn conv<'s>(scope: &mut Scope<'s, '_>, value: Value<'s>) -> Result<Self, Thrown> {
        super::prefix_from_js(scope, value).map(Prefix)
    }
}

/// What a native returns, converted to the script's value.
pub(crate) trait Ret {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s>;
}

impl Ret for () {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        Ok(v8::undefined(scope).into())
    }
}

impl Ret for bool {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        Ok(v8::Boolean::new(scope, self).into())
    }
}

impl Ret for String {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        Ok(string(scope, &self).into())
    }
}

impl Ret for &'static str {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        Ok(string(scope, self).into())
    }
}

impl Ret for char {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        Ok(string(scope, self.encode_utf8(&mut [0; 4])).into())
    }
}

macro_rules! ret_number {
    ($($t:ty),*) => {$(
        impl Ret for $t {
            fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
                Ok(number(scope, self as f64))
            }
        }
    )*};
}
ret_number!(f64, i64, i32, u64, u32, u8, usize);

/// `None` is undefined, as Emacs's nil is to scripts.
impl<T: Ret> Ret for Option<T> {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        match self {
            Some(v) => v.give(scope),
            None => Ok(v8::undefined(scope).into()),
        }
    }
}

impl<T: Ret> Ret for Vec<T> {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        let items = self.into_iter().map(|item| item.give(scope)).collect::<Result<Vec<_>, _>>()?;
        Ok(v8::Array::new_with_elements(scope, &items).into())
    }
}

impl<A: Ret, B: Ret> Ret for (A, B) {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        let items = [self.0.give(scope)?, self.1.give(scope)?];
        Ok(v8::Array::new_with_elements(scope, &items).into())
    }
}

impl<A: Ret, B: Ret, C: Ret> Ret for (A, B, C) {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        let items = [self.0.give(scope)?, self.1.give(scope)?, self.2.give(scope)?];
        Ok(v8::Array::new_with_elements(scope, &items).into())
    }
}

impl Ret for EditorValue {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::value_to_js(scope, &self)
    }
}

impl Ret for Record {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        let object = v8::Object::new(scope);
        for (name, field) in self.0 {
            let value = field.give(scope)?;
            super::set(scope, object, name, value);
        }
        Ok(object.into())
    }
}

impl Ret for Field {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        match self {
            Field::Undefined => Ok(v8::undefined(scope).into()),
            Field::Value(v) => v.give(scope),
            Field::Record(r) => r.give(scope),
            Field::List(items) => items.give(scope),
            Field::FaceAttrs(attrs) => attrs.give(scope),
        }
    }
}

impl<T: Ret> Ret for Box<T> {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        (*self).give(scope)
    }
}

impl Ret for e8_core::FaceAttrs {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::face_attrs_to_js(scope, &self)
    }
}

impl Ret for PlistOrValue {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::plist_or_value_to_js(scope, &self.0)
    }
}

impl Ret for Posn {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::posn_to_js(scope, self.0)
    }
}

impl Ret for e8_core::Match {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::match_to_js(scope, &self)
    }
}

/// Text properties, as an object of each property's value.
impl Ret for e8_core::Props {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::props_to_js(scope, &self)
    }
}

impl Ret for Prefix {
    fn give<'s>(self, scope: &mut Scope<'s, '_>) -> Js<'s> {
        super::prefix_to_js(scope, self.0)
    }
}
