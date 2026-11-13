//! Faces: named styles for text, as Emacs's xfaces.c has them. A face sets
//! some of Emacs's attributes (family, height, weight, slant, colours,
//! underline, overline, strike-through, box, inverse video, extend) and
//! inherits the rest from the faces its `:inherit` names. Faces can differ
//! between light and dark backgrounds, and text can carry an anonymous
//! face, a list of attributes in its `face` property. Colours are names
//! from E8's palette, which follows ArtCraft's, the names Emacs knows,
//! or Emacs's colour specs: `#rgb` to `#rrrrggggbbbb`, `rgb:R/G/B` and
//! `rgbi:R/G/B`, and `#rrggbbaa` with alpha.

use crate::editor::Editor;
use crate::variables::Value;

/// A colour, with alpha.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    const fn rgb(rgb: u32) -> Color {
        let [_, r, g, b] = rgb.to_be_bytes();
        Color { r, g, b, a: 255 }
    }

    const fn rgba(rgb: u32, a: u8) -> Color {
        let [_, r, g, b] = rgb.to_be_bytes();
        Color { r, g, b, a }
    }

    /// A palette name such as "accent", a colour name Emacs knows such as
    /// "dark slate gray", an Emacs colour spec, or `#rrggbbaa`.
    pub fn parse(spec: &str, dark: bool) -> Option<Color> {
        if let Some(color) = palette(spec, dark) {
            return Some(color);
        }
        if let Some(hex) = spec.strip_prefix('#')
            && hex.len() == 8
        {
            let byte = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
            return Some(Color { r: byte(0)?, g: byte(2)?, b: byte(4)?, a: byte(6)? });
        }
        let [r, g, b] = color_values(spec)?;
        // As Emacs rounds 16 bits to a display's 8.
        let byte = |v: u16| ((u32::from(v) * 255 + 32767) / 65535) as u8;
        Some(Color { r: byte(r), g: byte(g), b: byte(b), a: 255 })
    }
}

/// A colour's red, green and blue from 0 to 65535, as Emacs's `color-values`
/// gives them: from a name Emacs knows, compared without case or spaces,
/// or a spec `color_values_from_spec` reads.
pub fn color_values(spec: &str) -> Option<[u16; 3]> {
    if let Some(values) = color_values_from_spec(spec) {
        return Some(values);
    }
    let name: String = spec.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
    let names = &crate::colors_data::COLOR_NAMES;
    let i = names.binary_search_by(|(n, ..)| (*n).cmp(name.as_str())).ok()?;
    let (_, r, g, b) = names[i];
    Some([r, g, b])
}

/// Whether a colour reads better against white than black, as Emacs's
/// `color-dark-p` judges it: its components from 0 to 65535 made linear
/// with a gamma of 2.2, and their luminance under a grey of 0.6's.
pub fn color_dark_p(rgb: [u16; 3]) -> bool {
    let [r, g, b] = rgb.map(|v| (f64::from(v) / 65535.0).powf(2.2));
    0.2126 * r + 0.7152 * g + 0.0722 * b < 0.6f64.powf(2.2)
}

/// The names of the colours Emacs knows, as `defined-colors` lists them.
pub fn color_names() -> impl Iterator<Item = &'static str> {
    crate::colors_data::COLOR_NAMES.iter().map(|(n, ..)| *n)
}

/// A colour spec's values from 0 to 65535, as Emacs's
/// `color-values-from-color-spec` reads `#RGB` with one to four hex digits
/// for each, `rgb:R/G/B` with one to four for each, scaled to the full
/// range, and `rgbi:R/G/B` with numbers from 0 to 1.
pub fn color_values_from_spec(spec: &str) -> Option<[u16; 3]> {
    let hex = |digits: &str| -> Option<u16> {
        if digits.is_empty() || digits.len() > 4 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let v = u32::from_str_radix(digits, 16).ok()?;
        let max = (1u32 << (4 * digits.len())) - 1;
        Some(((v * 65535 + max / 2) / max) as u16)
    };
    if let Some(digits) = spec.strip_prefix('#') {
        let n = digits.len();
        if n == 0 || n % 3 != 0 || n > 12 {
            return None;
        }
        let k = n / 3;
        let part = |i: usize| hex(&digits[i * k..(i + 1) * k]);
        return Some([part(0)?, part(1)?, part(2)?]);
    }
    if let Some(rest) = spec.strip_prefix("rgb:") {
        let parts: Vec<&str> = rest.split('/').collect();
        let [r, g, b] = parts.as_slice() else { return None };
        return Some([hex(r)?, hex(g)?, hex(b)?]);
    }
    if let Some(rest) = spec.strip_prefix("rgbi:") {
        let parts: Vec<f64> = rest.split('/').map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
        let [r, g, b] = parts.as_slice() else { return None };
        let scale = |v: f64| (0.0..=1.0).contains(&v).then(|| (v * 65535.0).round() as u16);
        return Some([scale(*r)?, scale(*g)?, scale(*b)?]);
    }
    None
}

/// How far apart two colours look, as Emacs's `color-distance`: a weighted
/// distance in which red counts more for reddish colours.
pub fn color_distance(x: [u16; 3], y: [u16; 3]) -> i64 {
    let (xr, xg, xb) = (i64::from(x[0]), i64::from(x[1]), i64::from(x[2]));
    let (yr, yg, yb) = (i64::from(y[0]), i64::from(y[1]), i64::from(y[2]));
    let r = (xr - yr) >> 8;
    let g = (xg - yg) >> 8;
    let b = (xb - yb) >> 8;
    let r_mean = (xr + yr) >> 9;
    (((512 + r_mean) * r * r) >> 8) + 4 * g * g + (((767 - r_mean) * b * b) >> 8)
}

/// Whether a colour is a shade of grey, as Emacs's `color-gray-p`: near
/// black, or each pair of its components within a twentieth of the larger.
pub fn color_gray_p(values: [u16; 3]) -> bool {
    let [r, g, b] = values.map(i32::from);
    let close = |x: i32, y: i32| (x - y).abs() < x.max(y) / 20;
    (r < 5000 && g < 5000 && b < 5000) || (close(r, g) && close(g, b) && close(b, r))
}

/// E8's palette, after the ArtCraft Launcher's theme
/// (github.com/storytold/craft-launcher, MIT OR Apache-2.0): each name has a
/// dark and a light value.
const PALETTE: &[(&str, Color, Color)] = &[
    // The page: the buffer's background.
    ("bg", Color::rgb(0x121316), Color::rgb(0xf2f1ee)),
    // Wells, such as the mode line.
    ("sunken", Color::rgb(0x060607), Color::rgb(0xe9e8e4)),
    // Text.
    ("ink", Color::rgb(0xf2f1ee), Color::rgb(0x101014)),
    // Emphasis.
    ("ink-strong", Color::rgb(0xffffff), Color::rgb(0x000000)),
    // Secondary text.
    ("muted", Color::rgba(0xf2f1ee, 153), Color::rgba(0x101014, 158)),
    // Tertiary text.
    ("faint", Color::rgba(0xf2f1ee, 97), Color::rgba(0x101014, 107)),
    // Hairline rules.
    ("line", Color::rgba(0xf2f1ee, 38), Color::rgba(0x101014, 41)),
    // The brand blue, for surfaces.
    ("accent", Color::rgb(0x2d81ff), Color::rgb(0x2d81ff)),
    // The brand blue, for text.
    ("accent-ink", Color::rgb(0x74aaff), Color::rgb(0x1659c4)),
    // The active region: the brand blue, translucent.
    ("selection", Color::rgba(0x2d81ff, 92), Color::rgba(0x2d81ff, 64)),
    ("good", Color::rgb(0x3fd6b8), Color::rgb(0x0a7563)),
    ("warn", Color::rgb(0xffc14d), Color::rgb(0x8a5800)),
    ("bad", Color::rgb(0xff6259), Color::rgb(0xb3261e)),
];

/// A palette colour by name.
pub fn palette(name: &str, dark: bool) -> Option<Color> {
    PALETTE
        .iter()
        .find(|(n, ..)| *n == name)
        .map(|(_, d, l)| if dark { *d } else { *l })
}

pub fn palette_names() -> impl Iterator<Item = &'static str> {
    PALETTE.iter().map(|(name, ..)| *name)
}

/// A face's `:height`, as Emacs has it: an absolute size in tenths of a
/// point, or a factor of the size of the face it is laid over.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FaceHeight {
    Absolute(f64),
    Relative(f64),
}

impl FaceHeight {
    /// A height as Emacs reads a number: a whole number is absolute, in
    /// tenths of a point, and one with a fraction is a factor. Lisp keeps
    /// `2.0` apart from `2`; a number from a script cannot, so a factor
    /// that is a whole number comes as `(:factor 2)`, from a script's
    /// `{ factor: 2 }`: see [`FaceHeight::from_value`].
    pub fn from_number(n: f64) -> FaceHeight {
        if n.fract() == 0.0 { FaceHeight::Absolute(n) } else { FaceHeight::Relative(n) }
    }

    /// A height from a face attribute's value: a number, or `(:factor N)`
    /// for a factor, whole or not.
    pub fn from_value(value: &Value) -> Option<FaceHeight> {
        if let Value::List(items) = value {
            return plist_get(items, ":factor").and_then(Value::as_number).map(FaceHeight::Relative);
        }
        value.as_number().map(FaceHeight::from_number)
    }

    /// The height as a face attribute's value: a number, or `(:factor N)`
    /// for a factor that is a whole number, which a number would make absolute.
    pub fn to_value(self) -> Value {
        match self {
            FaceHeight::Relative(f) if f.fract() == 0.0 => Value::List(vec![Value::Symbol(":factor".into()), Value::Number(f)]),
            h => Value::Number(h.as_number()),
        }
    }

    pub fn as_number(self) -> f64 {
        match self {
            FaceHeight::Absolute(n) | FaceHeight::Relative(n) => n,
        }
    }

    /// This height laid over `below`, as Emacs merges a relative height
    /// onto the face under it.
    fn over(self, below: Option<FaceHeight>) -> FaceHeight {
        match (self, below) {
            (FaceHeight::Relative(f), Some(FaceHeight::Absolute(h))) => FaceHeight::Absolute(h * f),
            (FaceHeight::Relative(f), Some(FaceHeight::Relative(g))) => FaceHeight::Relative(f * g),
            (height, _) => height,
        }
    }
}

/// A line under, over or through text, as Emacs's `:underline`,
/// `:overline` and `:strike-through`: off, or on in a colour (the
/// foreground's when none) and a style such as `wave`.
#[derive(Clone, Debug, PartialEq)]
pub enum Decoration {
    Off,
    On { color: Option<String>, style: Option<String> },
}

impl Decoration {
    /// A decoration as Emacs gives one: t, nil, a colour, or a plist with
    /// `:color` and `:style`.
    fn from_value(value: &Value) -> Decoration {
        match value {
            Value::Null | Value::Bool(false) => Decoration::Off,
            Value::Str(c) | Value::Symbol(c) if c != "t" => Decoration::On { color: Some(c.clone()), style: None },
            Value::List(items) => {
                let get = |key: &str| plist_get(items, key).and_then(|v| v.as_str().map(str::to_string));
                // `foreground-color` means the text's own colour, as no colour does.
                let color = get(":color").filter(|c| c != "foreground-color");
                Decoration::On { color, style: get(":style") }
            }
            _ => Decoration::On { color: None, style: None },
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Decoration::Off => Value::Null,
            Decoration::On { color: None, style: None } => Value::Bool(true),
            Decoration::On { color: Some(c), style: None } => Value::Str(c.clone()),
            Decoration::On { color, style } => {
                let mut items = Vec::new();
                if let Some(c) = color {
                    items.extend([Value::Str(":color".into()), Value::Str(c.clone())]);
                }
                if let Some(s) = style {
                    items.extend([Value::Str(":style".into()), Value::Str(s.clone())]);
                }
                Value::List(items)
            }
        }
    }

    pub fn is_on(&self) -> bool {
        matches!(self, Decoration::On { .. })
    }
}

/// A face's `:box`: off, or a line round the text, `width` wide (a
/// negative width draws it inside the text's own space), in a colour (the
/// foreground's when none) and a style (`released-button`, `pressed-button`).
#[derive(Clone, Debug, PartialEq)]
pub enum FaceBox {
    Off,
    On { width: i32, color: Option<String>, style: Option<String> },
}

impl FaceBox {
    fn from_value(value: &Value) -> FaceBox {
        match value {
            Value::Null | Value::Bool(false) => FaceBox::Off,
            Value::Number(n) => FaceBox::On { width: *n as i32, color: None, style: None },
            Value::Str(c) | Value::Symbol(c) if c != "t" => FaceBox::On { width: 1, color: Some(c.clone()), style: None },
            Value::List(items) => {
                let width = match plist_get(items, ":line-width") {
                    Some(Value::Number(n)) => *n as i32,
                    Some(Value::List(pair)) => pair.first().and_then(Value::as_number).unwrap_or(1.0) as i32,
                    _ => 1,
                };
                let get = |key: &str| plist_get(items, key).and_then(|v| v.as_str().map(str::to_string));
                FaceBox::On { width, color: get(":color"), style: get(":style") }
            }
            _ => FaceBox::On { width: 1, color: None, style: None },
        }
    }

    fn to_value(&self) -> Value {
        match self {
            FaceBox::Off => Value::Null,
            FaceBox::On { width: 1, color: None, style: None } => Value::Bool(true),
            FaceBox::On { width, color, style } => {
                let mut items = vec![Value::Str(":line-width".into()), Value::Number(f64::from(*width))];
                if let Some(c) = color {
                    items.extend([Value::Str(":color".into()), Value::Str(c.clone())]);
                }
                if let Some(s) = style {
                    items.extend([Value::Str(":style".into()), Value::Str(s.clone())]);
                }
                Value::List(items)
            }
        }
    }
}

/// A key's value in a plist, its keys symbols or strings.
fn plist_get<'a>(items: &'a [Value], key: &str) -> Option<&'a Value> {
    items.chunks(2).find(|pair| pair[0].as_str() == Some(key)).and_then(|pair| pair.get(1))
}

/// Whether an Emacs `:weight` is bold or heavier, as the fonts it picks are.
pub fn is_bold_weight(weight: &str) -> bool {
    matches!(weight, "semi-bold" | "demibold" | "bold" | "extra-bold" | "ultra-bold" | "heavy" | "ultra-heavy" | "black")
}

/// Whether an Emacs `:slant` is italic or oblique.
pub fn is_italic_slant(slant: &str) -> bool {
    matches!(slant, "italic" | "oblique" | "reverse-italic" | "reverse-oblique")
}

/// The attributes Emacs's faces have, in the order `face-attributes-as-vector` gives them.
pub const FACE_ATTRIBUTES: [&str; 18] = [
    ":family",
    ":foundry",
    ":width",
    ":height",
    ":weight",
    ":slant",
    ":underline",
    ":inverse-video",
    ":foreground",
    ":background",
    ":stipple",
    ":overline",
    ":strike-through",
    ":box",
    ":font",
    ":inherit",
    ":extend",
    ":distant-foreground",
];

/// Some of a face's attributes, as Emacs's. `None` is `unspecified`,
/// which leaves the attribute to the next face.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FaceAttrs {
    /// The font family, as Emacs's `:family`: "Monospace", "Sans Serif" or a font's name.
    pub family: Option<String>,
    pub foundry: Option<String>,
    /// How wide the font is, as `condensed` or `expanded`.
    pub width: Option<String>,
    pub height: Option<FaceHeight>,
    /// From `ultra-light` to `ultra-heavy`; `bold` and heavier draw bold.
    pub weight: Option<String>,
    /// `normal`, `italic`, `oblique` and their reverses.
    pub slant: Option<String>,
    pub foreground: Option<String>,
    /// A colour for text whose background makes its foreground hard to see.
    pub distant_foreground: Option<String>,
    pub background: Option<String>,
    pub underline: Option<Decoration>,
    pub overline: Option<Decoration>,
    pub strike: Option<Decoration>,
    pub box_: Option<FaceBox>,
    pub inverse: Option<bool>,
    /// Whether the background reaches the window's edge after a line's end.
    pub extend: Option<bool>,
    pub stipple: Option<String>,
    pub font: Option<String>,
    /// The faces to take attributes this one does not set from, earlier
    /// ones first.
    pub inherit: Option<Vec<String>>,
}

impl FaceAttrs {
    /// These attributes with `over`'s set ones laid on top; a relative
    /// height multiplies the one below.
    pub fn with(&self, over: &FaceAttrs) -> FaceAttrs {
        fn pick<T: Clone>(over: &Option<T>, below: &Option<T>) -> Option<T> {
            over.clone().or_else(|| below.clone())
        }
        FaceAttrs {
            family: pick(&over.family, &self.family),
            foundry: pick(&over.foundry, &self.foundry),
            width: pick(&over.width, &self.width),
            height: over.height.map(|h| h.over(self.height)).or(self.height),
            weight: pick(&over.weight, &self.weight),
            slant: pick(&over.slant, &self.slant),
            foreground: pick(&over.foreground, &self.foreground),
            distant_foreground: pick(&over.distant_foreground, &self.distant_foreground),
            background: pick(&over.background, &self.background),
            underline: pick(&over.underline, &self.underline),
            overline: pick(&over.overline, &self.overline),
            strike: pick(&over.strike, &self.strike),
            box_: pick(&over.box_, &self.box_),
            inverse: over.inverse.or(self.inverse),
            extend: over.extend.or(self.extend),
            stipple: pick(&over.stipple, &self.stipple),
            font: pick(&over.font, &self.font),
            inherit: pick(&over.inherit, &self.inherit),
        }
    }

    /// Bold, as the shorthand of scripts and E8's own faces: weight `bold`.
    pub fn bold() -> FaceAttrs {
        FaceAttrs { weight: Some("bold".into()), ..Default::default() }
    }

    /// Whether the weight draws bold.
    pub fn is_bold(&self) -> bool {
        self.weight.as_deref().is_some_and(is_bold_weight)
    }

    pub fn is_italic(&self) -> bool {
        self.slant.as_deref().is_some_and(is_italic_slant)
    }

    /// Whether every attribute is unspecified, as `internal-lisp-face-empty-p` asks.
    pub fn is_empty(&self) -> bool {
        *self == FaceAttrs::default()
    }

    /// Attributes from an Emacs face plist, `(:height 1.2 :family "Sans
    /// Serif")`, its keys symbols or strings starting with a colon. An
    /// `unspecified` value leaves the attribute unspecified.
    pub fn from_plist(items: &[Value]) -> FaceAttrs {
        let mut attrs = FaceAttrs::default();
        for pair in items.chunks(2) {
            let [key, value] = pair else { break };
            if let Some(key) = key.as_str() {
                attrs.set(key, value);
            }
        }
        attrs
    }

    /// Sets one attribute from its Emacs value, as `set-face-attribute`
    /// does; `unspecified` unsets it. Returns whether the attribute is one
    /// faces have.
    pub fn set(&mut self, key: &str, value: &Value) -> bool {
        let unspecified = matches!(value, Value::Symbol(s) | Value::Str(s) if s == "unspecified");
        let text = || if unspecified { None } else { value.as_str().map(str::to_string) };
        let flag = || if unspecified { None } else { Some(value.is_true()) };
        match key {
            ":family" => self.family = text(),
            ":foundry" => self.foundry = text(),
            ":width" => self.width = text(),
            ":height" => self.height = if unspecified { None } else { FaceHeight::from_value(value) },
            ":weight" => self.weight = text(),
            ":slant" => self.slant = text(),
            ":foreground" => self.foreground = text(),
            ":distant-foreground" => self.distant_foreground = text(),
            ":background" => self.background = text(),
            ":underline" => self.underline = (!unspecified).then(|| Decoration::from_value(value)),
            ":overline" => self.overline = (!unspecified).then(|| Decoration::from_value(value)),
            ":strike-through" => self.strike = (!unspecified).then(|| Decoration::from_value(value)),
            ":box" => self.box_ = (!unspecified).then(|| FaceBox::from_value(value)),
            ":inverse-video" | ":reverse-video" => self.inverse = flag(),
            ":extend" => self.extend = flag(),
            ":stipple" => self.stipple = text(),
            ":font" => self.font = text(),
            ":inherit" => {
                self.inherit = match value {
                    _ if unspecified => None,
                    Value::Null => None,
                    Value::List(items) => Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
                    other => other.as_str().map(|s| vec![s.to_string()]),
                }
            }
            // Emacs's shorthands, which set the weight and slant.
            ":bold" => self.weight = Some(if value.is_true() { "bold" } else { "normal" }.into()),
            ":italic" => self.slant = Some(if value.is_true() { "italic" } else { "normal" }.into()),
            _ => return false,
        }
        true
    }

    /// One attribute as Emacs's `face-attribute` gives it, `unspecified`
    /// if it is not set.
    pub fn get(&self, key: &str) -> Value {
        // Names come back as strings, as scripts give them.
        let unspecified = || Value::Str("unspecified".into());
        let text = |v: &Option<String>| v.as_ref().map_or_else(unspecified, |s| Value::Str(s.clone()));
        let symbol = text;
        let flag = |v: Option<bool>| v.map_or_else(unspecified, Value::Bool);
        match key {
            ":family" => text(&self.family),
            ":foundry" => text(&self.foundry),
            ":width" => symbol(&self.width),
            ":height" => self.height.map_or_else(unspecified, FaceHeight::to_value),
            ":weight" => symbol(&self.weight),
            ":slant" => symbol(&self.slant),
            ":foreground" => text(&self.foreground),
            ":distant-foreground" => text(&self.distant_foreground),
            ":background" => text(&self.background),
            ":underline" => self.underline.as_ref().map_or_else(unspecified, Decoration::to_value),
            ":overline" => self.overline.as_ref().map_or_else(unspecified, Decoration::to_value),
            ":strike-through" => self.strike.as_ref().map_or_else(unspecified, Decoration::to_value),
            ":box" => self.box_.as_ref().map_or_else(unspecified, FaceBox::to_value),
            ":inverse-video" | ":reverse-video" => flag(self.inverse),
            ":extend" => flag(self.extend),
            ":stipple" => text(&self.stipple),
            ":font" => text(&self.font),
            ":inherit" => match &self.inherit {
                None => unspecified(),
                Some(list) if list.len() == 1 => Value::Str(list[0].clone()),
                Some(list) => Value::List(list.iter().map(|s| Value::Str(s.clone())).collect()),
            },
            _ => unspecified(),
        }
    }

    /// The attributes as a plist of those that are set, in Emacs's order.
    pub fn to_plist(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for key in FACE_ATTRIBUTES {
            let value = self.get(key);
            if !matches!(&value, Value::Str(s) if s == "unspecified") {
                out.push(Value::Str(key.to_string()));
                out.push(value);
            }
        }
        out
    }
}

/// A named face.
#[derive(Clone, Debug)]
pub struct Face {
    pub name: String,
    pub doc: String,
    /// Attributes for both backgrounds.
    pub attrs: FaceAttrs,
    /// What changes on a dark background.
    pub dark: FaceAttrs,
    /// What changes on a light background.
    pub light: FaceAttrs,
    pub source: Option<String>,
}

impl Face {
    pub fn new(name: &str, doc: &str, attrs: FaceAttrs) -> Face {
        Face {
            name: name.to_string(),
            doc: doc.to_string(),
            attrs,
            dark: FaceAttrs::default(),
            light: FaceAttrs::default(),
            source: None,
        }
    }

    /// The face's own attributes on a dark or light background.
    pub fn attrs_for(&self, dark: bool) -> FaceAttrs {
        self.attrs.with(if dark { &self.dark } else { &self.light })
    }
}

/// How text looks once its faces are resolved: what front ends draw.
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    pub foreground: Option<Color>,
    pub background: Option<Color>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// The underline's colour, when not the foreground's.
    pub underline_color: Option<Color>,
    /// Whether the underline is a wave, as Emacs draws `:style wave`.
    pub underline_wave: bool,
    pub overline: bool,
    pub overline_color: Option<Color>,
    pub strike: bool,
    pub strike_color: Option<Color>,
    /// A box round the text: its line's width and colour, the foreground's when none.
    pub box_line: Option<(i32, Option<Color>)>,
    /// Whether the background goes on to the window's edge after a line's end.
    pub extend: bool,
    /// Its size as a factor of the default face's.
    pub scale: f32,
    /// Its font family, if a face names one.
    pub family: Option<String>,
}

impl Default for Style {
    fn default() -> Style {
        Style {
            foreground: None,
            background: None,
            bold: false,
            italic: false,
            underline: false,
            underline_color: None,
            underline_wave: false,
            overline: false,
            overline_color: None,
            strike: false,
            strike_color: None,
            box_line: None,
            extend: false,
            scale: 1.0,
            family: None,
        }
    }
}

impl Style {
    /// Whether it is drawn in a proportional font: a family that is not a
    /// monospace one, as Emacs's `variable-pitch` face's "Sans Serif" is.
    pub fn proportional(&self) -> bool {
        self.family.as_deref().is_some_and(|f| !is_fixed_family(f))
    }
}

/// Whether a family is a monospace one: Emacs's generic "Monospace", or a
/// font whose name says so.
pub fn is_fixed_family(family: &str) -> bool {
    let f = family.to_ascii_lowercase();
    f == "monospace" || f == "fixed" || f.contains("mono") || f.contains("courier")
}

/// The default face's height, in tenths of a point, that absolute heights
/// are scaled against when it sets none: 12 points.
const DEFAULT_HEIGHT: f64 = 120.0;

/// Which background a change to a face applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Background {
    Both,
    Dark,
    Light,
}

/// The face names a `face` property holds: one name, or a list where
/// earlier faces win, as in Emacs. An anonymous face, a plist of
/// attributes such as `(:foreground "red" :weight bold)`, alone or in the
/// list, gets a name of its own that stands for it, as [`anonymous_face`]
/// gives one.
pub fn face_names(value: &Value) -> Vec<String> {
    match value {
        Value::Str(name) | Value::Symbol(name) => vec![name.clone()],
        Value::List(items) if is_plist(items) => vec![anonymous_face(items)],
        Value::List(items) => items
            .iter()
            .filter_map(|v| match v {
                Value::List(plist) if is_plist(plist) => Some(anonymous_face(plist)),
                other => other.as_str().map(str::to_string),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Whether a list is an attribute plist: it starts with a keyword.
fn is_plist(items: &[Value]) -> bool {
    matches!(items.first(), Some(Value::Symbol(k) | Value::Str(k)) if k.starts_with(':'))
}

/// What starts the name an anonymous face goes by, which no named face has.
const ANONYMOUS: char = '\u{1}';

thread_local! {
    /// Anonymous faces' attributes, each by the name standing for it, and
    /// the names by the plist each was made from.
    static ANONYMOUS_FACES: std::cell::RefCell<(std::collections::HashMap<String, String>, Vec<FaceAttrs>)> = Default::default();
}

/// The name standing for an anonymous face, the same for the same
/// attributes, so faces and styles can be named and cached as named
/// faces are.
pub fn anonymous_face(plist: &[Value]) -> String {
    let key = format!("{plist:?}");
    ANONYMOUS_FACES.with_borrow_mut(|(names, attrs)| {
        if let Some(name) = names.get(&key) {
            return name.clone();
        }
        let name = format!("{ANONYMOUS}{}", attrs.len());
        attrs.push(FaceAttrs::from_plist(plist));
        names.insert(key, name.clone());
        name
    })
}

/// An anonymous face's attributes, by the name standing for it.
fn anonymous_attrs(name: &str) -> Option<FaceAttrs> {
    let index: usize = name.strip_prefix(ANONYMOUS)?.parse().ok()?;
    ANONYMOUS_FACES.with_borrow(|(_, attrs)| attrs.get(index).cloned())
}

impl Editor {
    /// Defines a face, as Emacs's `defface` does: a face that already exists
    /// keeps its attributes, which may have been customised, and only its
    /// documentation changes.
    pub fn define_face(&mut self, face: Face) {
        self.style_cache.borrow_mut().clear();
        match self.faces.get_mut(&face.name) {
            Some(existing) => {
                existing.doc = face.doc;
                if face.source.is_some() {
                    existing.source = face.source;
                }
            }
            None => {
                self.faces.insert(face.name.clone(), face);
            }
        }
    }

    /// Changes some of a face's attributes (Emacs's `set-face-attribute`),
    /// defining the face if there is none.
    pub fn set_face_attributes(&mut self, name: &str, attrs: FaceAttrs, background: Background) {
        self.style_cache.borrow_mut().clear();
        let face = self
            .faces
            .entry(name.to_string())
            .or_insert_with(|| Face::new(name, "", FaceAttrs::default()));
        let target = match background {
            Background::Both => &mut face.attrs,
            Background::Dark => &mut face.dark,
            Background::Light => &mut face.light,
        };
        *target = target.with(&attrs);
    }

    /// Sets one attribute of a face from its Emacs value, as
    /// `set-face-attribute` does, `unspecified` unsetting it; defines the
    /// face if there is none. Returns whether faces have the attribute.
    pub fn set_face_attribute(&mut self, name: &str, key: &str, value: &Value, background: Background) -> bool {
        self.style_cache.borrow_mut().clear();
        let face = self.faces.entry(name.to_string()).or_insert_with(|| Face::new(name, "", FaceAttrs::default()));
        if background == Background::Both {
            // For both backgrounds, as Emacs's for every frame, the value
            // replaces what the face's definition gives either background:
            // a theme's diff-header background wins over the dark one
            // diff-mode defines.
            // A shorthand clears the attribute it sets.
            let cleared = match key {
                ":bold" => ":weight",
                ":italic" => ":slant",
                other => other,
            };
            let unspecified = Value::Str("unspecified".into());
            face.dark.set(cleared, &unspecified);
            face.light.set(cleared, &unspecified);
        }
        let target = match background {
            Background::Both => &mut face.attrs,
            Background::Dark => &mut face.dark,
            Background::Light => &mut face.light,
        };
        target.set(key, value)
    }

    pub fn face(&self, name: &str) -> Option<&Face> {
        self.faces.get(name)
    }

    /// Whether the frame's background is dark, for choosing faces' colours:
    /// as `frame-background-mode` says, or, unset, as Emacs judges the
    /// frame's background colour, here the `default` face's own background,
    /// with `color_dark_p`; without one, as the system looks to the front
    /// end (`set_system_dark`), dark until it says.
    pub fn dark_background(&self) -> bool {
        match self.variable("frame-background-mode").as_ref().and_then(Value::as_str) {
            Some("light") => false,
            Some("dark") => true,
            _ => self
                .faces
                .get("default")
                .and_then(|f| f.attrs.background.as_deref())
                .and_then(|spec| Color::parse(spec, true))
                .map_or(self.system_dark, |c| color_dark_p([c.r, c.g, c.b].map(|v| u16::from(v) * 257))),
        }
    }

    /// Tells the editor whether the system looks dark, as a graphical
    /// front end knows: what `dark_background` answers while no theme
    /// gives the default face a background.
    pub fn set_system_dark(&mut self, dark: bool) {
        if self.system_dark != dark {
            self.system_dark = dark;
            self.style_cache.borrow_mut().clear();
        }
    }

    /// One of a face's attributes as Emacs's `face-attribute` gives it, on
    /// the frame's background: the face's own, or with `inherit` what it
    /// inherits too; `unspecified` if neither sets it. An anonymous face's
    /// name works too.
    pub fn face_attribute(&self, name: &str, key: &str, inherit: bool) -> Value {
        let dark = self.dark_background();
        if inherit {
            return self.face_attrs(name, dark).get(key);
        }
        match anonymous_attrs(name) {
            Some(attrs) => attrs.get(key),
            None => self.faces.get(name).map_or(Value::Str("unspecified".into()), |f| f.attrs_for(dark).get(key)),
        }
    }

    /// Makes a face with no attributes, as `make-face`, if there is none.
    pub fn make_face(&mut self, name: &str) {
        self.style_cache.borrow_mut().clear();
        self.faces.entry(name.to_string()).or_insert_with(|| Face::new(name, "", FaceAttrs::default()));
    }

    /// Makes `new` a face with `old`'s attributes, as `copy-face`.
    pub fn copy_face(&mut self, old: &str, new: &str) {
        self.style_cache.borrow_mut().clear();
        let Some(face) = self.faces.get(old).cloned() else { return };
        let doc = self.faces.get(new).map(|f| f.doc.clone()).unwrap_or_default();
        self.faces.insert(new.to_string(), Face { name: new.to_string(), doc, source: None, ..face });
    }

    pub fn faces(&self) -> impl Iterator<Item = &Face> {
        self.faces.values()
    }

    /// A face's attributes with what it inherits filled in: from each face
    /// its `:inherit` names, earlier ones winning, as Emacs merges them.
    pub fn face_attrs(&self, name: &str, dark: bool) -> FaceAttrs {
        let mut attrs = self.inherited(name, dark, 0);
        attrs.inherit = None;
        attrs
    }

    fn inherited(&self, name: &str, dark: bool, depth: usize) -> FaceAttrs {
        // An inheritance loop would otherwise never end.
        if depth > 16 {
            return FaceAttrs::default();
        }
        let own = match anonymous_attrs(name) {
            Some(attrs) => attrs,
            None => match self.faces.get(name) {
                Some(face) => face.attrs_for(dark),
                None => return FaceAttrs::default(),
            },
        };
        self.with_inherited(own, dark, depth)
    }

    /// Attributes with what their `:inherit` faces set filled in under them.
    fn with_inherited(&self, own: FaceAttrs, dark: bool, depth: usize) -> FaceAttrs {
        let Some(parents) = own.inherit.clone() else { return own };
        let below = parents.iter().rev().fold(FaceAttrs::default(), |acc, p| acc.with(&self.inherited(p, dark, depth + 1)));
        below.with(&own)
    }

    /// The style of text with these faces, earlier ones winning. Kept until
    /// a face changes, as redisplay asks for the same few again and again.
    pub fn style_for(&self, faces: &[String], dark: bool) -> Style {
        self.cached_style(faces, dark, 0, || {
            let attrs = faces
                .iter()
                .rev()
                .fold(FaceAttrs::default(), |acc, name| acc.with(&self.face_attrs(name, dark)));
            self.style_from(&attrs, dark)
        })
    }

    /// A style from the cache, by the faces, the background and the
    /// remapping in force (0 for none), or made and kept.
    fn cached_style(&self, faces: &[String], dark: bool, remap: usize, make: impl FnOnce() -> Style) -> Style {
        let key = (faces.to_vec(), dark, remap);
        if let Some(style) = self.style_cache.borrow().get(&key) {
            return style.clone();
        }
        let style = make();
        let mut cache = self.style_cache.borrow_mut();
        // Anonymous faces could otherwise grow it without end.
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(key, style.clone());
        style
    }

    /// The number the style cache keys a `face-remapping-alist` value by,
    /// the same for equal values, as each buffer's text scaling sets one.
    fn remap_key(&self, remaps: &[Value]) -> usize {
        let mut known = self.style_remaps.borrow_mut();
        if let Some(i) = known.iter().position(|r| r.as_slice() == remaps) {
            return i + 1;
        }
        // Each remapping set afresh, as every step of text scaling is,
        // could otherwise grow it without end.
        if known.len() >= 64 {
            known.clear();
            self.style_cache.borrow_mut().retain(|k, _| k.2 == 0);
        }
        known.push(remaps.to_vec());
        known.len()
    }

    /// The style of text with these faces in a buffer, whose
    /// `face-remapping-alist` may remap them, as Emacs's face-remap.c has
    /// it: a remapped face is merged as its remapping says, a face name, an
    /// attribute plist or a list of these, the first winning, where the
    /// face's own name means the face itself. A remapped `default` face
    /// lies under all the buffer's text.
    pub fn style_for_in(&self, b: &crate::buffer::Buffer, faces: &[String], dark: bool) -> Style {
        let remaps = match self.variable_in(b, "face-remapping-alist") {
            Some(Value::List(entries)) if !entries.is_empty() => entries,
            _ => return self.style_for(faces, dark),
        };
        let remap_of = |name: &str| {
            remaps.iter().find_map(|e| match e {
                Value::List(items) if items.first().and_then(Value::as_str) == Some(name) => Some(&items[1..]),
                _ => None,
            })
        };
        let remapped = |name: &str| -> FaceAttrs {
            let Some(specs) = remap_of(name) else { return self.face_attrs(name, dark) };
            // A plist alone, `(default :height 1.2)`, or a list of specs.
            let plist = specs.first().is_some_and(|v| matches!(v, Value::Symbol(s) | Value::Str(s) if s.starts_with(':')));
            let one = |spec: &Value| match spec {
                Value::Str(s) if s == name => self.face_attrs(name, dark),
                Value::Str(s) => self.face_attrs(s, dark),
                Value::List(items) => self.resolve_inherit(FaceAttrs::from_plist(items), dark),
                _ => FaceAttrs::default(),
            };
            if plist {
                return self.resolve_inherit(FaceAttrs::from_plist(specs), dark);
            }
            specs.iter().rev().fold(FaceAttrs::default(), |acc, spec| acc.with(&one(spec)))
        };
        self.cached_style(faces, dark, self.remap_key(&remaps), || {
            let mut names: Vec<&str> = faces.iter().map(String::as_str).collect();
            if remap_of("default").is_some() {
                names.push("default");
            }
            let attrs = names.iter().rev().fold(FaceAttrs::default(), |acc, name| acc.with(&remapped(name)));
            self.style_from(&attrs, dark)
        })
    }

    /// Attributes with the faces they inherit from filled in under them.
    fn resolve_inherit(&self, attrs: FaceAttrs, dark: bool) -> FaceAttrs {
        let mut merged = self.with_inherited(attrs, dark, 0);
        merged.inherit = None;
        merged
    }

    /// What resolved attributes look like: absolute heights as factors of
    /// the default face's.
    fn style_from(&self, attrs: &FaceAttrs, dark: bool) -> Style {
        let color = |spec: &Option<String>| spec.as_deref().and_then(|s| Color::parse(s, dark));
        let base = match self.faces.get("default").and_then(|f| f.attrs.height) {
            Some(FaceHeight::Absolute(h)) if h > 0.0 => h,
            _ => DEFAULT_HEIGHT,
        };
        let scale = match attrs.height {
            Some(FaceHeight::Absolute(h)) => h / base,
            Some(FaceHeight::Relative(f)) => f,
            None => 1.0,
        };
        let (mut foreground, mut background) = (color(&attrs.foreground), color(&attrs.background));
        // As Emacs's xfaces.c: a foreground too near the background, by
        // color-distance and face-near-same-color-threshold, gives way to
        // the distant foreground, the default face's standing in for either
        // not set.
        if let Some(distant) = color(&attrs.distant_foreground) {
            let default = self.faces.get("default").map(|f| f.attrs_for(dark)).unwrap_or_default();
            let fg = foreground.or_else(|| color(&default.foreground)).or_else(|| palette("ink", dark));
            let bg = background.or_else(|| color(&default.background)).or_else(|| palette("bg", dark));
            let threshold = self.variable("face-near-same-color-threshold").and_then(|v| v.as_number()).unwrap_or(30000.0);
            if let (Some(fg), Some(bg)) = (fg, bg) {
                let wide = |c: Color| [c.r, c.g, c.b].map(|v| u16::from(v) * 257);
                if (color_distance(wide(fg), wide(bg)) as f64) < threshold {
                    foreground = Some(distant);
                }
            }
        }
        // Inverse video swaps them, the default face's standing in for one not set.
        if attrs.inverse == Some(true) {
            let default = self.faces.get("default").map(|f| f.attrs_for(dark)).unwrap_or_default();
            let fg = foreground.or_else(|| color(&default.foreground)).or_else(|| palette("ink", dark));
            let bg = background.or_else(|| color(&default.background)).or_else(|| palette("bg", dark));
            (foreground, background) = (bg, fg);
        }
        let line = |d: &Option<Decoration>| match d {
            Some(Decoration::On { color: c, style }) => (true, c.as_deref().and_then(|c| Color::parse(c, dark)), style.as_deref() == Some("wave")),
            _ => (false, None, false),
        };
        let (underline, underline_color, underline_wave) = line(&attrs.underline);
        let (overline, overline_color, _) = line(&attrs.overline);
        let (strike, strike_color, _) = line(&attrs.strike);
        let box_line = match &attrs.box_ {
            Some(FaceBox::On { width, color: c, .. }) => Some((*width, c.as_deref().and_then(|c| Color::parse(c, dark)))),
            _ => None,
        };
        Style {
            foreground,
            background,
            bold: attrs.is_bold(),
            italic: attrs.is_italic(),
            underline,
            underline_color,
            underline_wave,
            overline,
            overline_color,
            strike,
            strike_color,
            box_line,
            extend: attrs.extend == Some(true),
            scale: scale as f32,
            family: attrs.family.clone(),
        }
    }
}

/// The faces the core and the front ends use, with Emacs's names.
pub(crate) fn install(ed: &mut Editor) {
    let fg = |c: &str| FaceAttrs { foreground: Some(c.into()), ..Default::default() };
    let inherit = |f: &str| FaceAttrs { inherit: Some(vec![f.into()]), ..Default::default() };
    let bold = |c: &str| FaceAttrs { foreground: Some(c.into()), ..FaceAttrs::bold() };
    let on = Some(Decoration::On { color: None, style: None });
    let faces = [
        ("default", "The text of buffers.", fg("ink")),
        ("bold", "Bold text.", FaceAttrs::bold()),
        ("italic", "Italic text.", FaceAttrs { slant: Some("italic".into()), ..Default::default() }),
        ("bold-italic", "Bold italic text.", FaceAttrs { slant: Some("italic".into()), ..FaceAttrs::bold() }),
        ("underline", "Underlined text.", FaceAttrs { underline: on.clone(), ..Default::default() }),
        ("fixed-pitch", "Text in a fixed-width font.", FaceAttrs { family: Some("Monospace".into()), ..Default::default() }),
        ("variable-pitch", "Text in a proportional font, as variable-pitch-mode shows a buffer.", FaceAttrs { family: Some("Sans Serif".into()), ..Default::default() }),
        ("shadow", "Text that matters less, such as hints.", fg("muted")),
        ("link", "Links.", FaceAttrs { foreground: Some("accent-ink".into()), underline: on.clone(), ..Default::default() }),
        ("highlight", "Highlighting, such as of what the mouse is over.", FaceAttrs { background: Some("sunken".into()), ..Default::default() }),
        ("region", "The active region.", FaceAttrs { background: Some("selection".into()), ..Default::default() }),
        ("error", "Errors.", bold("bad")),
        ("warning", "Warnings.", bold("warn")),
        ("success", "Success.", bold("good")),
        ("minibuffer-prompt", "The minibuffer's prompt.", fg("accent-ink")),
        ("mode-line-buffer-id", "The buffer's name in the mode line.", fg("ink-strong")),
        ("mode-line-emphasis", "What stands out in the mode line, such as Def while a keyboard macro is defined.", fg("accent-ink")),
        ("fringe", "The fringes beside a window's text, and the bitmaps in them.", fg("faint")),
        ("header-line", "The header line at the top of a window, which `header-line-format` gives; front ends draw it as a bar, as the mode line.", FaceAttrs::default()),
        ("header-line-highlight", "What the mouse is over in the header line, such as a column title to sort by.", inherit("highlight")),
        ("tooltip", "Tooltips, which x-show-tip shows.", FaceAttrs { foreground: Some("ink-strong".into()), background: Some("sunken".into()), ..Default::default() }),
        ("menu", "Menus, where the front end draws them itself.", FaceAttrs { background: Some("sunken".into()), ..Default::default() }),
        ("tty-menu-enabled-face", "An item of a menu that can be chosen.", inherit("menu")),
        ("tty-menu-disabled-face", "An item of a menu that cannot be chosen, and a menu's titles.", FaceAttrs { foreground: Some("muted".into()), background: Some("sunken".into()), ..Default::default() }),
        ("tty-menu-selected-face", "The item of a menu the cursor is on.", FaceAttrs { background: Some("selection".into()), ..Default::default() }),
        ("font-lock-comment-face", "Comments.", FaceAttrs { foreground: Some("faint".into()), slant: Some("italic".into()), ..Default::default() }),
        ("font-lock-comment-delimiter-face", "The characters that start and end comments.", inherit("font-lock-comment-face")),
        ("font-lock-string-face", "Strings.", fg("good")),
        ("font-lock-doc-face", "Documentation strings.", inherit("font-lock-string-face")),
        ("font-lock-keyword-face", "Keywords.", fg("accent-ink")),
        ("font-lock-builtin-face", "Built-in names.", fg("accent-ink")),
        ("font-lock-function-name-face", "Names of functions being defined.", bold("ink-strong")),
        ("font-lock-variable-name-face", "Names of variables being defined.", fg("ink-strong")),
        ("font-lock-type-face", "Type names.", fg("warn")),
        ("font-lock-constant-face", "Constants.", fg("bad")),
        ("font-lock-warning-face", "Things to notice.", inherit("error")),
        ("font-lock-function-call-face", "Names of functions being called.", inherit("font-lock-function-name-face")),
        ("font-lock-variable-use-face", "Names of variables being used.", inherit("font-lock-variable-name-face")),
        ("font-lock-property-name-face", "Names of properties and fields.", inherit("font-lock-variable-name-face")),
        ("font-lock-property-use-face", "Properties and fields being used.", inherit("font-lock-property-name-face")),
        ("font-lock-number-face", "Numbers.", fg("bad")),
        ("font-lock-escape-face", "Escape sequences in strings.", inherit("font-lock-builtin-face")),
        ("font-lock-operator-face", "Operators.", FaceAttrs::default()),
        ("font-lock-punctuation-face", "Punctuation.", FaceAttrs::default()),
        ("font-lock-bracket-face", "Brackets.", inherit("font-lock-punctuation-face")),
        ("font-lock-delimiter-face", "Delimiters.", inherit("font-lock-punctuation-face")),
    ];
    for (name, doc, attrs) in faces {
        ed.define_face(Face::new(name, doc, attrs));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_come_from_the_palette_or_hex() {
        assert_eq!(Color::parse("accent", true), Some(Color::rgb(0x2d81ff)));
        assert_eq!(Color::parse("#102030", true), Some(Color::rgb(0x102030)));
        assert_eq!(Color::parse("#10203080", true), Some(Color::rgba(0x102030, 0x80)));
        assert_eq!(Color::parse("nope", true), None);
    }

    #[test]
    fn faces_inherit_and_combine() {
        let ed = Editor::new();
        let doc = ed.style_for(&["font-lock-doc-face".into()], true);
        assert_eq!(doc.foreground, palette("good", true));
        let both = ed.style_for(&["bold".into(), "font-lock-string-face".into()], false);
        assert!(both.bold);
        assert_eq!(both.foreground, palette("good", false));
        // Earlier faces win.
        let link_first = ed.style_for(&["link".into(), "error".into()], true);
        assert_eq!(link_first.foreground, palette("accent-ink", true));
        assert!(link_first.bold && link_first.underline);
    }

    #[test]
    fn set_face_attributes_per_background() {
        let mut ed = Editor::new();
        let red = FaceAttrs { foreground: Some("#ff0000".into()), ..Default::default() };
        ed.set_face_attributes("my-face", red, Background::Dark);
        assert_eq!(ed.style_for(&["my-face".into()], true).foreground, Some(Color::rgb(0xff0000)));
        assert_eq!(ed.style_for(&["my-face".into()], false).foreground, None);
    }
}
