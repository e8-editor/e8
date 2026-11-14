//! xfaces.c's primitives on Lisp faces, which faces.el is written on
//! (ADR 0085): a face's attributes as Emacs's face vector,
//! `[face FAMILY FOUNDRY WIDTH ...]`, made, copied, compared and changed
//! with the checks xfaces.c makes on each attribute and its messages;
//! `face-attributes-as-vector`, `frame--face-hash-table`, X resources'
//! values, the font selection order and alternatives, stipples' bitmap
//! specs and colour files. E8's faces are the same on every frame, so a
//! face's global definition and its definition on a frame are one: a FRAME
//! argument is checked as Emacs checks it, and then every frame answers
//! alike.

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::faces::{Background, Decoration, FACE_ATTRIBUTES, Face, FaceAttrs, FaceHeight};
use crate::variables::Value;

/// What the font primitives keep that faces do not hold: the order fonts
/// are matched in, the families and registries tried in place of others,
/// and whether a terminal shows bold faces in the default colours swapped.
#[derive(Clone, Debug)]
pub struct FaceSettings {
    pub font_sort_order: Vec<String>,
    pub alternative_families: Value,
    pub alternative_registries: Value,
    pub tty_suppress_bold_inverse: bool,
}

impl Default for FaceSettings {
    fn default() -> FaceSettings {
        FaceSettings {
            font_sort_order: [":width", ":height", ":weight", ":slant"].map(String::from).to_vec(),
            alternative_families: Value::Null,
            alternative_registries: Value::Null,
            tty_suppress_bold_inverse: false,
        }
    }
}

fn symbol(name: &str) -> Value {
    Value::Symbol(name.to_string())
}

fn unspecified() -> Value {
    symbol("unspecified")
}

/// Whether a value leaves an attribute to the faces under it: Emacs's
/// `unspecified`, and `reset` and `:ignore-defface`, which E8 takes as it.
fn is_unspecified(value: &Value) -> bool {
    matches!(value, Value::Symbol(s) | Value::Str(s) if s == "unspecified" || s == "reset" || s == ":ignore-defface")
}

/// The error xfaces.c's `signal_error` gives: its message and the value.
fn invalid(message: &str, value: &Value) -> Error {
    Error::signal(
        "error",
        format!("{message}: {}", crate::lread::prin1_to_string(value, false)),
        vec![Value::Str(message.to_string()), value.clone()],
    )
}

pub fn wrong_type(predicate: &str, value: &Value) -> Error {
    Error::signal(
        "wrong-type-argument",
        format!("Wrong type argument: {predicate}, {}", crate::lread::prin1_to_string(value, false)),
        vec![symbol(predicate), value.clone()],
    )
}

/// A name Emacs wants as a symbol; a script's string stands for one too.
fn symbol_name(value: &Value) -> Result<&str> {
    match value {
        Value::Symbol(s) | Value::Str(s) => Ok(s),
        Value::Null => Ok("nil"),
        Value::Bool(true) => Ok("t"),
        other => Err(wrong_type("symbolp", other)),
    }
}

/// A string Emacs wants as a string, not a symbol.
fn check_string(value: &Value) -> Result<&str> {
    match value {
        Value::Str(s) => Ok(s),
        Value::Text(t) => Ok(&t.string),
        other => Err(wrong_type("stringp", other)),
    }
}

/// Whether a number is a fixnum, as Lisp's integers are.
fn integer(value: &Value) -> Option<i64> {
    value.as_number().filter(|n| n.fract() == 0.0 && n.is_finite()).map(|n| n as i64)
}

fn plist_pairs(items: &[Value]) -> impl Iterator<Item = (&Value, Option<&Value>)> {
    items.chunks(2).map(|pair| (&pair[0], pair.get(1)))
}

pub(crate) fn is_nil(value: &Value) -> bool {
    matches!(value, Value::Null | Value::Bool(false)) || matches!(value, Value::Symbol(s) if s == "nil")
}

fn is_t(value: &Value) -> bool {
    matches!(value, Value::Bool(true)) || matches!(value, Value::Symbol(s) if s == "t")
}

/// Whether a style's name is in font.c's tables, as its
/// `FONT_*_NAME_NUMERIC` finds one.
fn style_known(attribute: &str, name: &str) -> bool {
    use crate::font::{SLANTS, WEIGHTS, WIDTHS, style_value};
    let table = match attribute {
        ":weight" => WEIGHTS,
        ":slant" => SLANTS,
        _ => WIDTHS,
    };
    style_value(table, name).is_some()
}

/// A face height laid over 10, as xfaces.c tests a height it is given.
fn height_over_ten(value: &Value) -> Option<f64> {
    match FaceHeight::from_value(value)? {
        FaceHeight::Absolute(n) => Some(n),
        FaceHeight::Relative(f) => Some((10.0 * f).floor()),
    }
}

/// An `:underline`'s value, as xfaces.c accepts one: t, nil, a colour,
/// or a plist whose `:color` and `:style` it knows.
fn valid_underline(value: &Value) -> bool {
    match value {
        v if is_nil(v) || is_t(v) => true,
        Value::Str(s) => !s.is_empty(),
        Value::List(items) => {
            for (key, val) in plist_pairs(items) {
                let val = val.unwrap_or(&Value::Null);
                let key_name = key.as_str().unwrap_or("");
                if is_nil(key) || (is_nil(val) && key_name != ":position") {
                    return false;
                }
                match key_name {
                    ":color" if !(matches!(val, Value::Symbol(s) if s == "foreground-color") || matches!(val, Value::Str(s) if !s.is_empty())) => return false,
                    ":style" if !matches!(val.as_str(), Some("line" | "double-line" | "wave" | "dots" | "dashes")) => return false,
                    _ => {}
                }
            }
            true
        }
        // xfaces.c errs on the side of acceptance for other symbols.
        Value::Symbol(_) => true,
        _ => false,
    }
}

/// A `:box`'s value, as xfaces.c accepts one.
fn valid_box(value: &Value) -> bool {
    match value {
        v if is_nil(v) => true,
        Value::Number(_) => integer(value).is_some_and(|n| n != 0),
        Value::Str(s) => !s.is_empty(),
        Value::List(items) => {
            if items.len() == 2 && integer(&items[0]).is_some() && integer(&items[1]).is_some() {
                return true;
            }
            if items.len() % 2 != 0 {
                return false;
            }
            plist_pairs(items).all(|(key, val)| {
                let val = val.unwrap_or(&Value::Null);
                match key.as_str() {
                    Some(":line-width") => match val {
                        Value::List(pair) if pair.len() == 2 => {
                            integer(&pair[0]).is_some_and(|n| n != 0) && integer(&pair[1]).is_some_and(|n| n != 0)
                        }
                        v => integer(v).is_some_and(|n| n != 0),
                    },
                    Some(":color") => is_nil(val) || matches!(val, Value::Str(s) if !s.is_empty()),
                    Some(":style") => is_nil(val) || matches!(val.as_str(), Some("pressed-button" | "released-button" | "flat-button")),
                    _ => false,
                }
            })
        }
        _ => false,
    }
}

/// Whether OBJECT is a bitmap spec, as `bitmap-spec-p`: a file name, or
/// `(WIDTH HEIGHT DATA)` with DATA long enough for the bits.
pub fn bitmap_spec_p(object: &Value) -> bool {
    match object {
        Value::Str(_) | Value::Text(_) => true,
        Value::List(items) if items.len() >= 3 => {
            let (Some(width), Some(height)) = (integer(&items[0]), integer(&items[1])) else { return false };
            let Some(data) = check_string(&items[2]).ok() else { return false };
            if width < 1 || height < 1 || width > i64::from(i32::MAX) || height > i64::from(i32::MAX) {
                return false;
            }
            let bytes_per_row = (width + 7) / 8;
            height <= data.len() as i64 / bytes_per_row
        }
        _ => false,
    }
}

/// Checks a face attribute's value as `internal-set-lisp-face-attribute`
/// does, signalling xfaces.c's errors, and gives the value to set:
/// `unspecified` for one that leaves the attribute unset.
fn check_attribute(face: &str, attribute: &str, value: &Value) -> Result<Value> {
    if is_unspecified(value) {
        return Ok(unspecified());
    }
    match attribute {
        ":family" | ":foundry" => {
            let s = check_string(value)?;
            if s.is_empty() {
                return Err(invalid(if attribute == ":family" { "Invalid face family" } else { "Invalid face foundry" }, value));
            }
        }
        ":height" => {
            if face == "default" {
                if integer(value).is_none_or(|n| n <= 0) {
                    return Err(invalid("Default face height not absolute and positive", value));
                }
            } else if height_over_ten(value).is_none_or(|n| n.fract() != 0.0 || n <= 0.0) {
                return Err(invalid("Face height does not produce a positive integer", value));
            }
        }
        ":weight" | ":slant" | ":width" => {
            let name = symbol_name(value)?;
            if !style_known(attribute, name) {
                let message = match attribute {
                    ":weight" => "Invalid face weight",
                    ":slant" => "Invalid face slant",
                    _ => "Invalid face width",
                };
                return Err(invalid(message, value));
            }
        }
        ":underline" => {
            if !valid_underline(value) {
                return Err(invalid("Invalid face underline", value));
            }
        }
        ":overline" | ":strike-through" => {
            let bad = match value {
                v if is_nil(v) || is_t(v) => false,
                Value::Symbol(_) => true,
                Value::Str(s) => s.is_empty(),
                _ => false,
            };
            if bad {
                return Err(invalid(if attribute == ":overline" { "Invalid face overline" } else { "Invalid face strike-through" }, value));
            }
        }
        ":box" => {
            if is_t(value) {
                return Ok(Value::Number(1.0));
            }
            if !valid_box(value) {
                return Err(invalid("Invalid face box", value));
            }
        }
        ":inverse-video" | ":reverse-video" | ":extend" => {
            symbol_name(value)?;
            if !is_t(value) && !is_nil(value) {
                let message = if attribute == ":extend" { "Invalid extend face attribute value" } else { "Invalid inverse-video face attribute value" };
                return Err(invalid(message, value));
            }
            return Ok(Value::Bool(is_t(value)));
        }
        ":foreground" | ":distant-foreground" | ":background" => {
            // nil is taken as unspecified, as Emacs 20 did.
            if is_nil(value) {
                return Ok(unspecified());
            }
            if check_string(value)?.is_empty() {
                let message = match attribute {
                    ":foreground" => "Empty foreground color value",
                    ":background" => "Empty background color value",
                    _ => "Empty distant-foreground color value",
                };
                return Err(invalid(message, value));
            }
        }
        ":stipple" => {
            if !is_nil(value) && !bitmap_spec_p(value) {
                return Err(invalid("Invalid stipple attribute", value));
            }
        }
        ":font" => match value {
            Value::Font(_) => {}
            Value::Str(name) => {
                if crate::font::font_spec_from_name(name).is_none() {
                    return Err(invalid("Invalid font name", value));
                }
            }
            other => return Err(invalid("Invalid font or font-spec", other)),
        },
        ":inherit" => {
            let ok = match value {
                Value::Symbol(_) | Value::Null | Value::Bool(_) => true,
                Value::List(items) => items.iter().all(|i| matches!(i, Value::Symbol(_) | Value::Null | Value::Bool(_))),
                _ => false,
            };
            if !ok {
                return Err(invalid("Invalid face inheritance", value));
            }
        }
        ":bold" | ":italic" => {}
        ":fontset" => {}
        _ => return Err(invalid("Invalid face attribute name", &symbol(attribute))),
    }
    Ok(value.clone())
}

/// A face's attribute as Emacs's face vector holds it: names as symbols,
/// flags as t or nil, and `unspecified` where it is not set.
pub fn lisp_attribute(attrs: &FaceAttrs, key: &str) -> Value {
    // A plist's keys as keywords and its style as a symbol, as Lisp writes them.
    fn keywords(value: Value) -> Value {
        let Value::List(items) = value else { return value };
        let mut out = Vec::with_capacity(items.len());
        let mut style = false;
        for (i, item) in items.into_iter().enumerate() {
            out.push(match item {
                Value::Str(s) if i % 2 == 0 && s.starts_with(':') => {
                    style = s == ":style";
                    Value::Symbol(s)
                }
                Value::Str(s) if i % 2 == 1 && style => Value::Symbol(s),
                other => other,
            });
        }
        Value::List(out)
    }
    let text = |v: &Option<String>| v.as_ref().map_or_else(unspecified, |s| Value::Str(s.clone()));
    let name = |v: &Option<String>| v.as_ref().map_or_else(unspecified, |s| symbol(s));
    let decoration = |v: &Option<Decoration>| v.as_ref().map_or_else(unspecified, |d| keywords(d.to_value()));
    match key {
        ":family" => text(&attrs.family),
        ":foundry" => text(&attrs.foundry),
        ":width" => name(&attrs.width),
        ":height" => attrs.height.map_or_else(unspecified, FaceHeight::to_value),
        ":weight" => name(&attrs.weight),
        ":slant" => name(&attrs.slant),
        ":underline" => decoration(&attrs.underline),
        ":inverse-video" | ":reverse-video" => attrs.inverse.map_or_else(unspecified, Value::Bool),
        ":foreground" => text(&attrs.foreground),
        ":background" => text(&attrs.background),
        ":stipple" => text(&attrs.stipple),
        ":overline" => decoration(&attrs.overline),
        ":strike-through" => decoration(&attrs.strike),
        ":box" => attrs.box_.as_ref().map_or_else(unspecified, |b| keywords(b.to_value())),
        ":font" => text(&attrs.font),
        ":inherit" => match &attrs.inherit {
            None => unspecified(),
            Some(list) if list.len() == 1 => symbol(&list[0]),
            Some(list) if list.is_empty() => Value::Null,
            Some(list) => Value::List(list.iter().map(|s| symbol(s)).collect()),
        },
        ":fontset" => text(&attrs.fontset),
        ":distant-foreground" => text(&attrs.distant_foreground),
        ":extend" => attrs.extend.map_or_else(unspecified, Value::Bool),
        _ => unspecified(),
    }
}

/// A face's attributes as Emacs's face vector: `face`, then each attribute.
pub fn lface_vector(attrs: &FaceAttrs) -> Value {
    let mut items = vec![symbol("face")];
    items.extend(FACE_ATTRIBUTES.iter().map(|key| lisp_attribute(attrs, key)));
    Value::List(items)
}

/// An attribute's name, `:weight` or a script's `weight`.
fn attribute_key(value: &Value) -> Result<String> {
    let name = symbol_name(value)?;
    Ok(if name.starts_with(':') { name.to_string() } else { format!(":{name}") })
}

/// What a FRAME argument names, as xfaces.c decodes one.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FaceFrame {
    /// nil: the selected frame, or the global definition, as the function has it.
    Default,
    /// t: the defaults for new frames.
    Global,
    /// A live frame.
    Frame,
    /// 0: every frame and the defaults.
    All,
}

impl Editor {
    /// Decodes a FRAME argument: nil, t, 0 or a live frame, else
    /// `wrong-type-argument frame-live-p`.
    pub fn face_frame(&self, frame: &Value) -> Result<FaceFrame> {
        match frame {
            v if is_nil(v) => Ok(FaceFrame::Default),
            v if is_t(v) => Ok(FaceFrame::Global),
            Value::Number(n) if *n == 0.0 => Ok(FaceFrame::All),
            Value::Frame(id) if self.frame_order.contains(id) => Ok(FaceFrame::Frame),
            other => Err(wrong_type("frame-live-p", other)),
        }
    }

    /// A face's name with `face-alias` followed, as `resolve_face_name`.
    pub fn resolve_face_name(&self, face: &str) -> String {
        let mut name = face.to_string();
        for _ in 0..10 {
            match self.get(&name, "face-alias").and_then(Value::as_str) {
                Some(alias) => name = alias.to_string(),
                None => break,
            }
        }
        name
    }

    /// A face's own attributes on the frame's background, as its Lisp face
    /// vector holds them; `Invalid face` if there is none.
    fn lface(&self, face: &str) -> Result<FaceAttrs> {
        let name = self.resolve_face_name(face);
        let dark = self.dark_background();
        self.faces.get(&name).map(|f| f.attrs_for(dark)).ok_or_else(|| invalid("Invalid face", &symbol(face)))
    }

    /// Makes a face with every attribute unspecified, as
    /// `internal-make-lisp-face`: a new one, or an existing one emptied.
    /// Gives its vector.
    pub fn internal_make_lisp_face(&mut self, face: &str) -> Value {
        self.style_cache.borrow_mut().clear();
        match self.faces.get_mut(face) {
            Some(existing) => {
                existing.attrs = FaceAttrs::default();
                existing.dark = FaceAttrs::default();
                existing.light = FaceAttrs::default();
            }
            None => {
                self.faces.insert(face.to_string(), Face::new(face, "", FaceAttrs::default()));
            }
        }
        lface_vector(&FaceAttrs::default())
    }

    /// A face's vector if it is one, as `internal-lisp-face-p`.
    pub fn internal_lisp_face_p(&self, face: &str) -> Option<Value> {
        self.lface(face).ok().map(|attrs| lface_vector(&attrs))
    }

    /// Makes TO a face with FROM's attributes, as `internal-copy-lisp-face`.
    pub fn internal_copy_lisp_face(&mut self, from: &str, to: &str) -> Result<()> {
        let source = self.faces.get(&self.resolve_face_name(from)).cloned().ok_or_else(|| invalid("Invalid face", &symbol(from)))?;
        self.style_cache.borrow_mut().clear();
        let face = self.faces.entry(to.to_string()).or_insert_with(|| Face::new(to, "", FaceAttrs::default()));
        face.attrs = source.attrs;
        face.dark = source.dark;
        face.light = source.light;
        Ok(())
    }

    /// Sets one of a face's attributes, as `internal-set-lisp-face-attribute`,
    /// with xfaces.c's checks; makes the face if there is none.
    pub fn internal_set_lisp_face_attribute(&mut self, face: &str, attribute: &Value, value: &Value) -> Result<()> {
        let key = attribute_key(attribute)?;
        let name = self.resolve_face_name(face);
        let value = check_attribute(&name, &key, value)?;
        let value = match (key.as_str(), &value) {
            (":font", Value::Font(font)) => Value::Str(font.name.clone().unwrap_or_else(|| font.xlfd_name(false))),
            (":fontset", v) if !is_unspecified(v) => {
                let set = v.as_str().and_then(|n| self.query_fontset(n, false));
                match set {
                    Some(set) => Value::Str(set),
                    None => return Err(invalid("Invalid fontset name", v)),
                }
            }
            (":inherit", v) if is_nil(v) => Value::List(Vec::new()),
            _ => value,
        };
        let known = self.set_face_attribute(&name, &key, &value, Background::Both);
        debug_assert!(known, "{key}");
        Ok(())
    }

    /// One of a face's own attributes, as `internal-get-lisp-face-attribute`.
    pub fn internal_get_lisp_face_attribute(&self, face: &str, attribute: &Value) -> Result<Value> {
        let attrs = self.lface(face)?;
        let key = attribute_key(attribute)?;
        if key == ":reverse-video" || FACE_ATTRIBUTES.contains(&key.as_str()) {
            Ok(lisp_attribute(&attrs, &key))
        } else {
            Err(invalid("Invalid face attribute name", &symbol(&key)))
        }
    }

    /// Whether two faces' attributes are all equal, as `internal-lisp-face-equal-p`.
    pub fn internal_lisp_face_equal_p(&self, face1: &str, face2: &str) -> Result<bool> {
        let (a, b) = (self.lface(face1)?, self.lface(face2)?);
        Ok(lface_vector(&a) == lface_vector(&b))
    }

    /// Whether a face sets no attribute, as `internal-lisp-face-empty-p`.
    pub fn internal_lisp_face_empty_p(&self, face: &str) -> Result<bool> {
        Ok(self.lface(face)?.is_empty())
    }

    /// Checks FACE is a face, as `internal-merge-in-global-face` does
    /// before merging its global definition into a frame's: one and the
    /// same in E8.
    pub fn internal_merge_in_global_face(&self, face: &str) -> Result<()> {
        self.lface(face).map(|_| ())
    }

    /// The faces as `frame--face-hash-table` holds them: each named face
    /// and its vector.
    pub fn face_vectors(&self) -> Vec<(String, Value)> {
        let dark = self.dark_background();
        self.faces.values().map(|f| (f.name.clone(), lface_vector(&f.attrs_for(dark)))).collect()
    }

    /// The attributes a face reference gives, as `face-attributes-as-vector`:
    /// a face's name, a plist of attributes, or a list of them, earlier ones
    /// winning, with what each inherits merged in. The vector's first slot
    /// is `unspecified`, and `:inherit` is nil once a face was merged.
    pub fn face_attributes_as_vector(&self, reference: &Value) -> Value {
        let dark = self.dark_background();
        let mut merged_face = false;
        let mut attrs = self.merge_face_ref(reference, dark, &mut merged_face, 0);
        if merged_face {
            attrs.inherit = Some(Vec::new());
        }
        let mut items = vec![unspecified()];
        items.extend(FACE_ATTRIBUTES.iter().map(|key| lisp_attribute(&attrs, key)));
        Value::List(items)
    }

    fn merge_face_ref(&self, reference: &Value, dark: bool, merged_face: &mut bool, depth: usize) -> FaceAttrs {
        if depth > 16 {
            return FaceAttrs::default();
        }
        let named = |name: &str, merged_face: &mut bool| {
            let name = self.resolve_face_name(name);
            if self.faces.contains_key(&name) {
                *merged_face = true;
                self.face_attrs(&name, dark)
            } else {
                FaceAttrs::default()
            }
        };
        match reference {
            Value::Symbol(name) | Value::Str(name) => named(name, merged_face),
            Value::List(items) if items.first().and_then(Value::as_str).is_some_and(|k| k.starts_with(':')) => {
                // A plist of attributes; one it does not know is skipped.
                let mut own = FaceAttrs::default();
                let mut inherit = None;
                for (key, value) in plist_pairs(items) {
                    let (Some(key), Some(value)) = (key.as_str(), value) else { continue };
                    if key == ":inherit" {
                        inherit = Some(value.clone());
                        continue;
                    }
                    if let Ok(value) = check_attribute("", key, value)
                        && !is_unspecified(&value)
                        && own.get(key) == Value::Str("unspecified".into())
                    {
                        own.set(key, &value);
                    }
                }
                match inherit {
                    Some(parents) => self.merge_face_ref(&parents, dark, merged_face, depth + 1).with(&own),
                    None => own,
                }
            }
            Value::List(items) => items.iter().rev().fold(FaceAttrs::default(), |below, item| below.with(&self.merge_face_ref(item, dark, merged_face, depth + 1))),
            _ => FaceAttrs::default(),
        }
    }

    /// Sets an attribute from an X resource's string, as
    /// `internal-set-lisp-face-attribute-from-resource`: a height as a
    /// number, flags from "on", "true", "off" and "false", styles as
    /// symbols, boxes and inheritance read as Lisp.
    pub fn internal_set_lisp_face_attribute_from_resource(&mut self, face: &str, attribute: &Value, value: &str) -> Result<()> {
        let key = attribute_key(attribute)?;
        let boolean = |s: &str| match s.to_ascii_lowercase().as_str() {
            "on" | "true" => Some(Value::Bool(true)),
            "off" | "false" => Some(Value::Bool(false)),
            "unspecified" => Some(unspecified()),
            _ => None,
        };
        let parsed = if value.eq_ignore_ascii_case("unspecified") {
            unspecified()
        } else {
            match key.as_str() {
                ":height" => {
                    let n = crate::lread::read_from_string(value, 0).ok().map(|(v, _)| v).filter(|v| integer(v).is_some_and(|n| n > 0));
                    match n {
                        Some(n) => n,
                        None => {
                            let number = value.trim().parse::<f64>().map(Value::Number).unwrap_or(Value::Number(0.0));
                            return Err(invalid("Invalid face height from X resource", &number));
                        }
                    }
                }
                ":bold" | ":italic" | ":reverse-video" | ":inverse-video" | ":extend" => match boolean(value) {
                    Some(v) => v,
                    None => return Err(invalid("Invalid face attribute value from X resource", &Value::Str(value.to_string()))),
                },
                ":weight" | ":slant" | ":width" => symbol(value),
                ":underline" | ":overline" | ":strike-through" => boolean(value).unwrap_or_else(|| Value::Str(value.to_string())),
                ":box" | ":inherit" => crate::lread::read_from_string(value, 0)?.0,
                _ => Value::Str(value.to_string()),
            }
        };
        self.internal_set_lisp_face_attribute(face, &symbol(&key), &parsed)
    }

    /// Sets the order fonts are matched in, as
    /// `internal-set-font-selection-order`: `:width`, `:height`, `:weight`
    /// and `:slant`, each once, in some order.
    pub fn internal_set_font_selection_order(&mut self, order: &Value) -> Result<()> {
        let items = match order {
            Value::List(items) => items.as_slice(),
            v if is_nil(v) => &[],
            other => return Err(wrong_type("listp", other)),
        };
        let fail = || invalid("Invalid font sort order", order);
        if items.len() != 4 {
            return Err(fail());
        }
        let mut names = Vec::new();
        for item in items {
            match item.as_str() {
                Some(name @ (":width" | ":height" | ":weight" | ":slant")) => names.push(name.to_string()),
                _ => return Err(fail()),
            }
        }
        if names != self.face_settings.font_sort_order {
            self.face_settings.font_sort_order = names;
            self.style_cache.borrow_mut().clear();
        }
        Ok(())
    }

    /// Keeps the families to try in place of others, as
    /// `internal-set-alternative-font-family-alist`, its names as symbols,
    /// or the registries, as `internal-set-alternative-font-registry-alist`,
    /// downcased. Gives the alist kept.
    pub fn internal_set_alternative_fonts(&mut self, alist: &Value, registries: bool) -> Result<Value> {
        let entries = match alist {
            Value::List(items) => items.as_slice(),
            v if is_nil(v) => &[],
            other => return Err(wrong_type("listp", other)),
        };
        let mut out = Vec::new();
        for entry in entries {
            let names = match entry {
                Value::List(items) => items.as_slice(),
                v if is_nil(v) => &[],
                other => return Err(wrong_type("listp", other)),
            };
            let mut kept = Vec::new();
            for name in names {
                kept.push(if registries {
                    Value::Str(check_string(name)?.to_lowercase())
                } else {
                    symbol(match name {
                        Value::Symbol(s) => s,
                        other => check_string(other)?,
                    })
                });
            }
            out.push(Value::List(kept));
        }
        let kept = Value::List(out);
        if registries {
            self.face_settings.alternative_registries = kept.clone();
        } else {
            self.face_settings.alternative_families = kept.clone();
        }
        self.style_cache.borrow_mut().clear();
        Ok(kept)
    }

    /// Forgets resolved faces, as `clear-face-cache`.
    pub fn clear_face_cache(&mut self) {
        self.style_cache.borrow_mut().clear();
    }

    /// Whether a terminal shows bold faces in its default colours swapped,
    /// as `tty-suppress-bold-inverse-default-colors` sets.
    pub fn tty_suppress_bold_inverse_default_colors(&mut self, suppress: bool) {
        self.face_settings.tty_suppress_bold_inverse = suppress;
        self.style_cache.borrow_mut().clear();
    }

    /// The font selection order and alternatives, as they were last set.
    pub fn face_settings(&self) -> &FaceSettings {
        &self.face_settings
    }
}

/// The colours a file names a line each, `R G B NAME`, as
/// `x-load-color-file` reads them: an alist of names and their RGB as one
/// number, last line first; nil if there is no such file.
pub fn x_load_color_file(path: &str) -> Value {
    let Ok(text) = crate::vfs::read_to_string(path) else { return Value::Null };
    let mut out = Vec::new();
    for line in text.lines() {
        let mut rest = line.trim_start();
        let mut rgb = [0i64; 3];
        let mut ok = true;
        for slot in &mut rgb {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '+').collect();
            match digits.parse::<i64>() {
                Ok(n) => *slot = n,
                Err(_) => {
                    ok = false;
                    break;
                }
            }
            rest = rest[digits.len()..].trim_start();
        }
        if ok {
            let color = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
            out.push(Value::List(vec![Value::Str(rest.to_string()), Value::Number(color as f64)]));
        }
    }
    out.reverse();
    Value::List(out)
}
