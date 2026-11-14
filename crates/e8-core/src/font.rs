//! Fonts as Lisp sees them, as Emacs's font.c: font specs, entities and
//! objects as values (`font-spec`, `font-get`, `font-put`, `fontp`), their
//! XLFD names (`font-xlfd-name`), names parsed in the XLFD and Fontconfig
//! forms, and the questions a front end's fonts answer: `font-family-list`,
//! `face-font`, `font-at`, `find-font`, `list-fonts`, `font-info`,
//! `query-font`, `font-has-char-p` and `x-list-fonts`. A terminal has no
//! fonts, so there they answer nil, as on Emacs's text terminals.

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::layout::{FontMetrics, FontSpec};
use crate::variables::Value;

/// Emacs's `font-weight-table`, `font-slant-table` and `font-width-table`:
/// each style's numeric value and its names.
const WEIGHTS: &[(u32, &[&str])] = &[
    (0, &["thin"]),
    (40, &["ultra-light", "ultralight", "extra-light", "extralight"]),
    (50, &["light"]),
    (55, &["semi-light", "semilight", "demilight"]),
    (80, &["regular", "normal", "unspecified", "book"]),
    (100, &["medium"]),
    (180, &["semi-bold", "semibold", "demibold", "demi-bold", "demi"]),
    (200, &["bold"]),
    (205, &["extra-bold", "extrabold", "ultra-bold", "ultrabold"]),
    (210, &["black", "heavy"]),
    (250, &["ultra-heavy", "ultraheavy"]),
];
const SLANTS: &[(u32, &[&str])] = &[
    (0, &["reverse-oblique", "ro"]),
    (10, &["reverse-italic", "ri"]),
    (100, &["normal", "r", "unspecified"]),
    (200, &["italic", "i", "ot"]),
    (210, &["oblique", "o"]),
];
const WIDTHS: &[(u32, &[&str])] = &[
    (50, &["ultra-condensed", "ultracondensed"]),
    (63, &["extra-condensed", "extracondensed"]),
    (75, &["condensed", "compressed", "narrow"]),
    (87, &["semi-condensed", "semicondensed", "demicondensed"]),
    (100, &["normal", "medium", "regular", "unspecified"]),
    (113, &["semi-expanded", "semiexpanded", "demiexpanded"]),
    (125, &["expanded"]),
    (150, &["extra-expanded", "extraexpanded"]),
    (200, &["ultra-expanded", "ultraexpanded", "wide"]),
];

/// Spacings, as font.h numbers them.
const PROPORTIONAL: f64 = 0.0;
const DUAL: f64 = 90.0;
const MONO: f64 = 100.0;
const CHARCELL: f64 = 110.0;

/// What a font value is, as Emacs distinguishes them: a spec to match
/// fonts against, an entity naming a font that exists, or an open font.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FontKind {
    Spec,
    Entity,
    Object,
}

impl FontKind {
    pub fn name(self) -> &'static str {
        match self {
            FontKind::Spec => "font-spec",
            FontKind::Entity => "font-entity",
            FontKind::Object => "font-object",
        }
    }

    pub fn from_name(name: &str) -> Option<FontKind> {
        match name {
            "font-spec" => Some(FontKind::Spec),
            "font-entity" => Some(FontKind::Entity),
            "font-object" => Some(FontKind::Object),
            _ => None,
        }
    }
}

/// A font's size: in pixels, as an integer `:size` gives it, or in
/// points, as a float does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FontSize {
    Pixels(f64),
    Points(f64),
}

/// A font spec, entity or object, as Emacs's font vectors hold them.
#[derive(Clone, Debug, PartialEq)]
pub struct Font {
    pub kind: FontKind,
    pub foundry: Option<String>,
    pub family: Option<String>,
    pub adstyle: Option<String>,
    pub registry: Option<String>,
    /// Style names, as given or as the tables name them.
    pub weight: Option<String>,
    pub slant: Option<String>,
    pub width: Option<String>,
    pub size: Option<FontSize>,
    pub dpi: Option<f64>,
    pub spacing: Option<f64>,
    pub avgwidth: Option<f64>,
    /// An open font's name.
    pub name: Option<String>,
    /// The properties with no slot of their own (`:script`, `:lang`,
    /// `:otf` and any others), keys without their colons.
    pub extra: Vec<(String, Value)>,
}

impl Font {
    pub fn new(kind: FontKind) -> Font {
        Font {
            kind,
            foundry: None,
            family: None,
            adstyle: None,
            registry: None,
            weight: None,
            slant: None,
            width: None,
            size: None,
            dpi: None,
            spacing: None,
            avgwidth: None,
            name: None,
            extra: Vec::new(),
        }
    }

    /// A property's value, as `font-get` gives it: names as symbols, the
    /// size a number, nil for none.
    pub fn get(&self, key: &str) -> Value {
        let key = key.strip_prefix(':').unwrap_or(key);
        let sym = |s: &Option<String>| s.as_ref().map_or(Value::Null, |s| Value::Symbol(s.clone()));
        let num = |n: Option<f64>| n.map_or(Value::Null, Value::Number);
        match key {
            "foundry" => sym(&self.foundry),
            "family" => sym(&self.family),
            "adstyle" => sym(&self.adstyle),
            "registry" => sym(&self.registry),
            "weight" => sym(&self.weight),
            "slant" => sym(&self.slant),
            "width" => sym(&self.width),
            "size" => match self.size {
                Some(FontSize::Pixels(n) | FontSize::Points(n)) => Value::Number(n),
                None => Value::Null,
            },
            "dpi" => num(self.dpi),
            "spacing" => num(self.spacing),
            "avgwidth" => num(self.avgwidth),
            "name" if self.kind == FontKind::Object => self.name.clone().map_or(Value::Null, Value::Str),
            _ => self.extra.iter().find(|(k, _)| k == key).map_or(Value::Null, |(_, v)| v.clone()),
        }
    }

    /// Sets a property, as `font-put`, checking it as `font-spec` does.
    pub fn put(&mut self, key: &str, value: Value) -> Result<()> {
        let bare = key.strip_prefix(':').unwrap_or(key);
        let invalid = || Error::signal("error", "invalid font property", vec![Value::List(vec![Value::Symbol(format!(":{bare}")), value.clone()])]);
        let name = |v: &Value| -> Result<Option<String>> {
            match v {
                Value::Null => Ok(None),
                Value::Str(s) | Value::Symbol(s) => Ok(Some(s.clone())),
                Value::Text(t) => Ok(Some(t.string.clone())),
                _ => Err(invalid()),
            }
        };
        let style = |table: &[(u32, &[&str])], v: &Value| -> Result<Option<String>> {
            match v {
                Value::Null => Ok(None),
                Value::Symbol(s) if table.iter().any(|(_, names)| names.contains(&s.as_str())) => Ok(Some(s.clone())),
                _ => Err(invalid()),
            }
        };
        let number = |v: &Value| -> Result<Option<f64>> {
            match v {
                Value::Null => Ok(None),
                Value::Number(n) if *n >= 0.0 => Ok(Some(*n)),
                _ => Err(invalid()),
            }
        };
        match bare {
            "foundry" => self.foundry = name(&value)?,
            "family" => self.family = name(&value)?,
            "adstyle" => self.adstyle = name(&value)?,
            "registry" => self.registry = name(&value)?.map(|r| r.to_lowercase()),
            "weight" => self.weight = style(WEIGHTS, &value)?,
            "slant" => self.slant = style(SLANTS, &value)?,
            "width" => self.width = style(WIDTHS, &value)?,
            "size" => {
                self.size = match value {
                    Value::Null => None,
                    // A whole number is pixels and a fraction points; a
                    // script cannot say 12.0, so `:point-size` stands for it.
                    Value::Number(n) if n >= 0.0 && n.fract() == 0.0 => Some(FontSize::Pixels(n)),
                    Value::Number(n) if n >= 0.0 => Some(FontSize::Points(n)),
                    _ => return Err(invalid()),
                }
            }
            "point-size" => self.size = number(&value)?.map(FontSize::Points),
            "dpi" => self.dpi = number(&value)?,
            "avgwidth" => self.avgwidth = number(&value)?,
            "spacing" => {
                self.spacing = match &value {
                    Value::Null => None,
                    Value::Number(n) if *n >= 0.0 => Some(*n),
                    Value::Symbol(s) if s.chars().count() == 1 => Some(match s.to_ascii_lowercase().as_str() {
                        "p" => PROPORTIONAL,
                        "d" => DUAL,
                        "m" => MONO,
                        "c" => CHARCELL,
                        _ => return Err(invalid()),
                    }),
                    _ => return Err(invalid()),
                }
            }
            "name" if self.kind != FontKind::Spec => self.name = name(&value)?,
            // A name is parsed into the properties it gives.
            "name" => {
                let Some(text) = name(&value)? else { return Ok(()) };
                parse_name(self, &text).map_err(|_| invalid())?;
            }
            _ => match self.extra.iter_mut().find(|(k, _)| k == bare) {
                Some(slot) => slot.1 = value,
                None => self.extra.push((bare.to_string(), value)),
            },
        }
        Ok(())
    }

    /// The font as a property list, `:point-size` for a size in points,
    /// which [`Font::from_plist`] reads back, for scripts to hold.
    pub fn to_plist(&self) -> Vec<Value> {
        let mut out = Vec::new();
        let mut push = |key: &str, value: Value| {
            if value != Value::Null {
                out.push(Value::Symbol(format!(":{key}")));
                out.push(value);
            }
        };
        for key in ["foundry", "family", "adstyle", "registry", "weight", "slant", "width", "dpi", "spacing", "avgwidth", "name"] {
            push(key, self.get(key));
        }
        match self.size {
            Some(FontSize::Pixels(n)) => push("size", Value::Number(n)),
            Some(FontSize::Points(n)) => push("point-size", Value::Number(n)),
            None => {}
        }
        for (k, v) in &self.extra {
            push(k, v.clone());
        }
        out
    }

    pub fn from_plist(kind: FontKind, plist: &[Value]) -> Result<Font> {
        let mut font = Font::new(kind);
        for pair in plist.chunks(2) {
            let key = pair[0].as_str().ok_or_else(|| Error::new("Invalid font property"))?;
            let value = pair.get(1).cloned().ok_or_else(|| Error::new(format!("No value for key ‘{key}’")))?;
            font.put(key, value)?;
        }
        Ok(font)
    }

    /// Its XLFD name, as font.c's `font_unparse_xlfd`, with runs of
    /// wildcards folded into one when asked, as `font-xlfd-name`'s
    /// FOLD-WILDCARDS. An open font's name is its own.
    pub fn xlfd_name(&self, fold: bool) -> String {
        if self.kind == FontKind::Object
            && let Some(name) = &self.name
        {
            return name.clone();
        }
        let field = |s: &Option<String>| s.clone().unwrap_or_else(|| "*".into());
        let style = |s: &Option<String>| s.as_ref().map_or_else(|| "*".to_string(), |s| s.chars().filter(|c| !matches!(c, '-' | '?' | ',' | '"')).collect());
        let registry = match &self.registry {
            None => "*-*".to_string(),
            Some(r) if r.contains('-') => r.clone(),
            Some(r) if r.ends_with('*') => format!("{r}-*"),
            Some(r) => format!("{r}*-*"),
        };
        let size = match self.size {
            Some(FontSize::Pixels(n)) if n > 0.0 => format!("{}-*", n as i64),
            Some(FontSize::Points(n)) => format!("*-{:.0}", n * 10.0),
            _ => "*-*".into(),
        };
        let dpi = self.dpi.map_or_else(|| "*-*".to_string(), |d| format!("{0}-{0}", d as i64));
        let spacing = match self.spacing {
            None => "*",
            Some(s) if s <= PROPORTIONAL => "p",
            Some(s) if s <= DUAL => "d",
            Some(s) if s <= MONO => "m",
            Some(_) => "c",
        };
        let avgwidth = self.avgwidth.map_or_else(|| "*".to_string(), |w| (w as i64).to_string());
        let mut name = format!(
            "-{}-{}-{}-{}-{}-{}-{}-{}-{}-{}-{}",
            field(&self.foundry),
            field(&self.family),
            style(&self.weight),
            style(&self.slant),
            style(&self.width),
            field(&self.adstyle),
            size,
            dpi,
            spacing,
            avgwidth,
            registry
        );
        if fold {
            let mut from = 0;
            while let Some(i) = name[from..].find("-*-*") {
                let at = from + i;
                name.replace_range(at..at + 4, "-*");
                from = at;
            }
        }
        name
    }

    /// Whether a font matches this spec: each property it has, the other has too.
    fn matches(&self, other: &Font) -> bool {
        let same = |a: &Option<String>, b: &Option<String>| a.as_ref().is_none_or(|a| b.as_ref().is_some_and(|b| a.eq_ignore_ascii_case(b)));
        let same_style = |table: &[(u32, &[&str])], a: &Option<String>, b: &Option<String>| {
            a.as_ref().is_none_or(|a| b.as_ref().is_some_and(|b| style_value(table, a) == style_value(table, b)))
        };
        same(&self.family, &other.family)
            && same(&self.foundry, &other.foundry)
            && same_style(WEIGHTS, &self.weight, &other.weight)
            && same_style(SLANTS, &self.slant, &other.slant)
            && same_style(WIDTHS, &self.width, &other.width)
            && self.spacing.is_none_or(|s| other.spacing.is_none_or(|o| o == s))
    }
}

impl Font {
    /// Whether a spec matches a font, as font.c's `font_match_p`: the
    /// foundry, family, adstyle and registry each the same where both have
    /// one, the weight, slant and width the same where the font has them,
    /// and the size the same where the spec has one and the font a size.
    /// The spacing is not compared, as Emacs does not; nor, in E8, the
    /// `:script` and `:lang` a spec may ask for.
    pub fn match_p(&self, font: &Font) -> bool {
        let differ = |a: &Option<String>, b: &Option<String>| matches!((a, b), (Some(a), Some(b)) if a != b);
        if differ(&self.foundry, &font.foundry)
            || differ(&self.family, &font.family)
            || differ(&self.adstyle, &font.adstyle)
            || differ(&self.registry, &font.registry)
        {
            return false;
        }
        let style_differs = |table: &[(u32, &[&str])], a: &Option<String>, b: &Option<String>| match (a, b) {
            (Some(a), Some(b)) => style_value(table, a) != style_value(table, b),
            _ => false,
        };
        if style_differs(WEIGHTS, &self.weight, &font.weight)
            || style_differs(SLANTS, &self.slant, &font.slant)
            || style_differs(WIDTHS, &self.width, &font.width)
        {
            return false;
        }
        let pixels = |s: FontSize| match s {
            FontSize::Pixels(n) => n,
            // A size in points is in pixels at 72 dots an inch, as E8's frames have it.
            FontSize::Points(n) => n.round(),
        };
        match (self.size, font.size) {
            (Some(want), Some(have)) if pixels(have) > 0.0 => {
                pixels(want) == pixels(have) && self.dpi.is_none_or(|d| font.dpi == Some(d)) && self.avgwidth.is_none_or(|a| font.avgwidth == Some(a))
            }
            _ => true,
        }
    }

    /// The face attributes a font gives, as `font-face-attributes`: its
    /// family, height in tenths of a point, weight, slant and width, each
    /// only if it has one.
    pub fn face_attributes(&self) -> Vec<Value> {
        let mut out = Vec::new();
        if let Some(family) = &self.family {
            out.extend([Value::Symbol(":family".into()), Value::Str(family.clone())]);
        }
        match self.size {
            Some(FontSize::Pixels(n)) => {
                let dpi = self.dpi.unwrap_or(72.0);
                out.extend([Value::Symbol(":height".into()), Value::Number((n * 10.0 * 72.0 / dpi).trunc())]);
            }
            Some(FontSize::Points(n)) => out.extend([Value::Symbol(":height".into()), Value::Number(10.0 * n.trunc())]),
            None => {}
        }
        // Each style as the face attribute its numeric value names.
        for (key, value, table) in [(":weight", &self.weight, WEIGHTS), (":slant", &self.slant, SLANTS), (":width", &self.width, WIDTHS)] {
            if let Some(name) = value.as_deref().and_then(|v| style_for_face(table, v)) {
                out.extend([Value::Symbol(key.into()), Value::Symbol(name.into())]);
            }
        }
        out
    }
}

/// A style's name as a face attribute gives it, as font.c's
/// `FONT_*_FOR_FACE`: the first name of its numeric value.
fn style_for_face(table: &[(u32, &[&'static str])], name: &str) -> Option<&'static str> {
    let n = style_value(table, name)?;
    table.iter().find(|(v, _)| *v == n).map(|(_, names)| names[0])
}

fn style_value(table: &[(u32, &[&str])], name: &str) -> Option<u32> {
    table.iter().find(|(_, names)| names.contains(&name)).map(|(n, _)| *n)
}

/// Parses a font name into a spec, as font.c's `font_parse_name`: an XLFD
/// name when it starts with `-`, else Fontconfig's `FAMILY-SIZE:PROP=VALUE`
/// or GTK's `FAMILY STYLE SIZE`.
fn parse_name(font: &mut Font, name: &str) -> Result<()> {
    if name.starts_with('-') {
        return parse_xlfd(font, name);
    }
    let (head, props) = match name.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (name, None),
    };
    // GTK's form: the size last after a space, no colon.
    if props.is_none()
        && let Some((family, size)) = head.rsplit_once(' ')
        && let Ok(size) = size.parse::<f64>()
    {
        let mut family = family.to_string();
        for (word, key, value) in [(" Bold", "weight", "bold"), (" Italic", "slant", "italic"), (" Oblique", "slant", "oblique")] {
            if let Some(rest) = family.strip_suffix(word) {
                font.put(key, Value::Symbol(value.into()))?;
                family = rest.to_string();
            }
        }
        font.family = Some(family);
        font.size = Some(FontSize::Points(size));
        return Ok(());
    }
    // Fontconfig's: a size after the last unescaped `-` that is a number.
    match head.rsplit_once('-') {
        Some((family, size)) if size.parse::<f64>().is_ok() => {
            font.family = (!family.is_empty()).then(|| family.replace("\\-", "-"));
            font.size = Some(FontSize::Points(size.parse().unwrap_or(0.0)));
        }
        _ => font.family = (!head.is_empty()).then(|| head.replace("\\-", "-")),
    }
    for prop in props.into_iter().flat_map(|p| p.split(':')).filter(|p| !p.is_empty()) {
        match prop.split_once('=') {
            Some(("pixelsize", v)) => font.size = Some(FontSize::Pixels(v.parse().map_err(|_| Error::new("invalid font name"))?)),
            Some(("size", v)) => font.size = Some(FontSize::Points(v.parse().map_err(|_| Error::new("invalid font name"))?)),
            Some(("spacing", v)) => {
                font.spacing = Some(match v {
                    "mono" | "100" => MONO,
                    "proportional" | "0" => PROPORTIONAL,
                    "dual" | "90" => DUAL,
                    "charcell" | "110" => CHARCELL,
                    _ => return Err(Error::new("invalid font name")),
                })
            }
            Some((key @ ("weight" | "slant" | "width" | "foundry" | "adstyle" | "registry" | "dpi"), v)) => {
                let value = if key == "dpi" { Value::Number(v.parse().map_err(|_| Error::new("invalid font name"))?) } else { Value::Symbol(v.to_lowercase()) };
                font.put(key, value)?;
            }
            Some((key, v)) => font.put(key, Value::Str(v.to_string()))?,
            // A bare style name, as `:bold` or `:italic`.
            None => {
                let v = prop.to_lowercase();
                let key = if style_value(WEIGHTS, &v).is_some() {
                    "weight"
                } else if style_value(SLANTS, &v).is_some() {
                    "slant"
                } else if style_value(WIDTHS, &v).is_some() {
                    "width"
                } else {
                    continue;
                };
                font.put(key, Value::Symbol(v))?;
            }
        }
    }
    Ok(())
}

/// Parses an XLFD name's 14 fields, `*` leaving a property unset.
fn parse_xlfd(font: &mut Font, name: &str) -> Result<()> {
    let fields: Vec<&str> = name[1..].split('-').collect();
    if fields.len() != 14 {
        return Err(Error::new("invalid XLFD name"));
    }
    let given = |f: &str| (f != "*" && !f.is_empty()).then(|| f.to_string());
    font.foundry = given(fields[0]);
    font.family = given(fields[1]);
    for (key, field) in [("weight", fields[2]), ("slant", fields[3]), ("width", fields[4])] {
        if let Some(v) = given(field) {
            font.put(key, Value::Symbol(v.to_lowercase()))?;
        }
    }
    font.adstyle = given(fields[5]);
    let number = |f: &str| given(f).and_then(|f| f.parse::<f64>().ok());
    font.size = match (number(fields[6]), number(fields[7])) {
        (Some(px), _) => Some(FontSize::Pixels(px)),
        (None, Some(pt)) => Some(FontSize::Points(pt / 10.0)),
        _ => None,
    };
    font.dpi = number(fields[8]);
    if let Some(s) = given(fields[10]) {
        font.put("spacing", Value::Symbol(s))?;
    }
    font.avgwidth = number(fields[11]);
    font.registry = match (given(fields[12]), given(fields[13])) {
        (Some(r), Some(e)) => Some(format!("{r}-{e}").to_lowercase()),
        (Some(r), None) => Some(r.to_lowercase()),
        _ => None,
    };
    Ok(())
}

/// A font spec from a font's name, as font.c's `font_spec_from_name`;
/// none for a name it cannot parse.
pub fn font_spec_from_name(name: &str) -> Option<Font> {
    let mut font = Font::new(FontKind::Spec);
    parse_name(&mut font, name).ok()?;
    Some(font)
}

/// Makes a font spec from a property list, as `font-spec`.
pub fn font_spec(plist: &[Value]) -> Result<Font> {
    if plist.len() % 2 == 1 {
        let key = plist.last().and_then(Value::as_str).unwrap_or_default();
        return Err(Error::new(format!("No value for key ‘{key}’")));
    }
    Font::from_plist(FontKind::Spec, plist)
}

/// Whether an XLFD pattern, with `*` for any run and `?` for any one
/// character, matches a name, ignoring case, as `x-list-fonts` matches.
pub(crate) fn xlfd_matches(pattern: &str, name: &str) -> bool {
    let (p, n): (Vec<char>, Vec<char>) = (pattern.to_lowercase().chars().collect(), name.to_lowercase().chars().collect());
    let (mut pi, mut ni, mut star, mut mark) = (0, 0, None, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

impl Editor {
    /// The open font a front end draws a face in, as Emacs's realized face
    /// has one, or none on a terminal.
    fn open_font(&self, spec: &FontSpec) -> Option<(Font, FontMetrics)> {
        let m = self.metrics.font_metrics(spec)?;
        let mut font = Font::new(FontKind::Object);
        font.family = Some(m.family.clone());
        font.weight = Some(if m.bold { "bold" } else { "regular" }.into());
        font.slant = Some(if m.italic { "italic" } else { "normal" }.into());
        font.width = Some("normal".into());
        font.size = Some(FontSize::Pixels(m.size.round() as f64));
        font.spacing = Some(if m.monospace { MONO } else { PROPORTIONAL });
        font.avgwidth = Some(0.0);
        font.registry = Some("iso10646-1".into());
        font.name = Some(Font { kind: FontKind::Entity, ..font.clone() }.xlfd_name(false));
        Some((font, m))
    }

    fn face_font_spec(&self, faces: &[String]) -> FontSpec {
        FontSpec::of(&self.style_for(faces, true))
    }

    /// The name of the font a face is drawn in, as `face-font`, with the
    /// default face's attributes under it; none on a terminal.
    pub fn face_font(&self, face: &str) -> Option<String> {
        let faces = if face == "default" { vec!["default".to_string()] } else { vec![face.to_string(), "default".to_string()] };
        self.open_font(&self.face_font_spec(&faces)).and_then(|(f, _)| f.name)
    }

    /// The open font text at a position in the current buffer is drawn in,
    /// as `font-at`; none on a terminal.
    pub fn font_at(&self, pos: usize) -> Option<Font> {
        let mut faces = self.faces_at(self.buffer(), pos);
        faces.push("default".into());
        self.open_font(&self.face_font_spec(&faces)).map(|(f, _)| f)
    }

    /// The font families the front end has, sorted, as `font-family-list`.
    pub fn font_family_list(&self) -> Vec<String> {
        let mut families = self.metrics.font_families();
        families.sort();
        families.dedup();
        families
    }

    /// The fonts that exist matching a spec, as entities, as `list-fonts`.
    /// E8's front ends offer each family in its regular, bold, italic
    /// and bold italic styles.
    pub fn list_fonts(&self, spec: &Font, max: Option<usize>) -> Vec<Font> {
        let families = self.font_family_list();
        let mut out = Vec::new();
        for family in families.iter().filter(|f| spec.family.as_ref().is_none_or(|want| want.eq_ignore_ascii_case(f))) {
            for (weight, slant) in [("regular", "normal"), ("bold", "normal"), ("regular", "italic"), ("bold", "italic")] {
                let mut entity = Font::new(FontKind::Entity);
                entity.family = Some(family.clone());
                entity.weight = Some(weight.into());
                entity.slant = Some(slant.into());
                entity.width = Some("normal".into());
                entity.registry = Some("iso10646-1".into());
                entity.spacing = Some(if crate::faces::is_fixed_family(family) { MONO } else { PROPORTIONAL });
                if spec.matches(&entity) {
                    out.push(entity);
                }
            }
        }
        if let Some(max) = max {
            out.truncate(max);
        }
        out
    }

    /// The font that best matches a spec, as `find-font`.
    pub fn find_font(&self, spec: &Font) -> Option<Font> {
        self.list_fonts(spec, Some(1)).into_iter().next()
    }

    /// The names of the fonts matching an XLFD pattern, as `x-list-fonts`.
    pub fn x_list_fonts(&self, pattern: &str, max: Option<usize>) -> Vec<String> {
        let mut names: Vec<String> = self
            .list_fonts(&Font::new(FontKind::Spec), None)
            .into_iter()
            .map(|f| f.xlfd_name(false))
            .filter(|name| xlfd_matches(pattern, name))
            .collect();
        if let Some(max) = max {
            names.truncate(max);
        }
        names
    }

    /// An open font's metrics, as `query-font`: its name, file, pixel
    /// size, maximum width, ascent, descent, space width and average
    /// width. E8's front ends keep no file name.
    pub fn query_font(&self, font: &Font) -> Option<Vec<Value>> {
        let family = font.family.clone()?;
        let default = self.metrics.font_metrics(&FontSpec::default_font())?.size;
        let size = match font.size {
            Some(FontSize::Pixels(n) | FontSize::Points(n)) if default > 0.0 => n as f32 / default,
            _ => 1.0,
        };
        let spec = FontSpec {
            family: (!crate::faces::is_fixed_family(&family)).then_some(family),
            scale: size,
            bold: font.weight.as_deref().and_then(|w| style_value(WEIGHTS, w)).is_some_and(|w| w >= 180),
            italic: font.slant.as_deref().and_then(|s| style_value(SLANTS, s)).is_some_and(|s| s >= 200),
        };
        let (open, m) = self.open_font(&spec)?;
        let n = |v: f32| Value::Number(f64::from(v.round()));
        Some(vec![
            open.name.map_or(Value::Null, Value::Str),
            Value::Null,
            n(m.size),
            n(m.max_width),
            n(m.ascent),
            n(m.descent),
            n(m.space_width),
            n(m.average_width),
            Value::List(vec![Value::Symbol("opentype".into())]),
        ])
    }

    /// What `font-info` says of a font by name: its name twice, size,
    /// height, baseline offset, compose numbers, maximum width, ascent,
    /// descent, space and average widths, file and capability.
    pub fn font_info(&self, name: &str) -> Option<Vec<Value>> {
        let mut spec = Font::new(FontKind::Spec);
        parse_name(&mut spec, name).ok()?;
        if spec.family.as_ref().is_some_and(|f| !self.font_family_list().iter().any(|g| g.eq_ignore_ascii_case(f))) {
            return None;
        }
        let q = self.query_font(&spec)?;
        let num = |v: &Value| v.as_number().unwrap_or(0.0);
        Some(vec![
            q[0].clone(),
            q[0].clone(),
            q[2].clone(),
            Value::Number(num(&q[4]) + num(&q[5])),
            Value::Number(0.0),
            Value::Number(0.0),
            Value::Number(0.0),
            q[3].clone(),
            q[4].clone(),
            q[5].clone(),
            q[6].clone(),
            q[7].clone(),
            Value::Null,
            q[8].clone(),
        ])
    }

    /// The open font a spec, entity or object stands for, as a front end
    /// draws it, for the font.c primitives that open fonts.
    fn spec_of(&self, font: &Font) -> FontSpec {
        let default = self.metrics.font_metrics(&FontSpec::default_font()).map_or(0.0, |m| m.size);
        let scale = match font.size {
            Some(FontSize::Pixels(n) | FontSize::Points(n)) if default > 0.0 && n > 0.0 => n as f32 / default,
            _ => 1.0,
        };
        FontSpec {
            family: font.family.clone().filter(|f| !crate::faces::is_fixed_family(f)),
            scale,
            bold: font.weight.as_deref().and_then(|w| style_value(WEIGHTS, w)).is_some_and(|w| w >= 180),
            italic: font.slant.as_deref().and_then(|s| style_value(SLANTS, s)).is_some_and(|s| s >= 200),
        }
    }

    /// Opens a font entity at a size, as `open-font`: an integer size in
    /// pixels, a float in points, 0 for 12 points, none for the entity's own;
    /// none on a terminal.
    pub fn open_font_entity(&self, entity: &Font, size: Option<f64>) -> Option<Font> {
        let mut want = entity.clone();
        if let Some(size) = size {
            want.size = Some(if size == 0.0 { FontSize::Pixels(12.0) } else { FontSize::Pixels(size.round()) });
        }
        let (mut font, _) = self.open_font(&self.spec_of(&want))?;
        if let Some(family) = &entity.family
            && self.font_family_list().iter().any(|f| f == family)
        {
            font.family = Some(family.clone());
            font.name = Some(Font { kind: FontKind::Entity, ..font.clone() }.xlfd_name(false));
        }
        Some(font)
    }

    /// An open font's glyphs for characters, as `font-get-glyphs`: for
    /// each, `[FROM TO C CODE WIDTH LBEARING RBEARING ASCENT DESCENT nil]`,
    /// or nil where the font has none. E8's front ends give no glyph
    /// codes, so a glyph's code is its character's.
    pub fn font_get_glyphs(&self, font: &Font, chars: &[char]) -> Vec<Value> {
        let spec = self.spec_of(font);
        let metrics = self.metrics.font_metrics(&spec);
        chars
            .iter()
            .enumerate()
            .map(|(i, &c)| {
                let Some(m) = metrics.as_ref().filter(|_| self.metrics.has_glyph(&spec, c)) else { return Value::Null };
                let width = f64::from(self.metrics.advance(&spec, c).round());
                let n = |v: f64| Value::Number(v);
                Value::List(vec![
                    n(i as f64),
                    n(i as f64),
                    n(f64::from(c as u32)),
                    n(f64::from(c as u32)),
                    n(width),
                    n(0.0),
                    n(width),
                    n(f64::from(m.ascent.round())),
                    n(f64::from(m.descent.round())),
                    Value::Null,
                ])
            })
            .collect()
    }

    /// The font a character is shown in and its glyph code, as
    /// `internal-char-font`: the character at a position in the current
    /// buffer, or CH there, in the faces there, or CH in the default face
    /// with no position. None on a terminal, where the buffer is in no
    /// window, or where no font has a glyph for it. The code is the
    /// character's, as `font-get-glyphs` gives it.
    pub fn internal_char_font(&self, pos: Option<usize>, ch: Option<u32>) -> Result<Option<(Font, u32)>> {
        let (c, faces) = match pos {
            None => {
                let c = ch.ok_or_else(|| crate::xfaces::wrong_type("characterp", &Value::Null))?;
                (c, vec!["default".to_string()])
            }
            Some(pos) => {
                let b = self.buffer();
                if pos < b.point_min() || pos >= b.point_max() {
                    return Err(Error::signal(
                        "args-out-of-range",
                        format!("Args out of range: {}, {}, {}", pos + 1, b.point_min() + 1, b.point_max() + 1),
                        vec![Value::Number(pos as f64 + 1.0), Value::Number(b.point_min() as f64 + 1.0), Value::Number(b.point_max() as f64 + 1.0)],
                    ));
                }
                let c = match ch {
                    Some(c) => c,
                    None => b.char_at(pos).map_or(0, |c| c as u32),
                };
                let id = self.buffer().id;
                let shown = self.window_list().into_iter().any(|w| self.window(w).is_some_and(|w| w.buffer == id));
                if !shown {
                    return Ok(None);
                }
                let mut faces = self.faces_at(b, pos);
                faces.push("default".into());
                (c, faces)
            }
        };
        let Some(c) = char::from_u32(c) else { return Ok(None) };
        let spec = self.face_font_spec(&faces);
        if !self.metrics.has_glyph(&spec, c) {
            return Ok(None);
        }
        Ok(self.open_font(&spec).map(|(font, _)| (font, c as u32)))
    }

    /// The fonts of a family, or all, as `x-family-fonts`: for each,
    /// `[FAMILY WIDTH POINT-SIZE WEIGHT SLANT FIXED-P FULL REGISTRY]`,
    /// sorted by the font selection order and then by family. E8's fonts
    /// scale, so their point size is 0.
    pub fn x_family_fonts(&self, family: Option<&str>) -> Vec<Value> {
        let mut fonts: Vec<Font> =
            self.list_fonts(&Font::new(FontKind::Spec), None).into_iter().filter(|f| family.is_none_or(|p| f.family.as_deref().is_some_and(|name| xlfd_matches(p, name)))).collect();
        let order = self.face_settings().font_sort_order.clone();
        let key = |f: &Font| {
            let mut key: Vec<u32> = order
                .iter()
                .map(|attr| match attr.as_str() {
                    ":width" => f.width.as_deref().and_then(|w| style_value(WIDTHS, w)).unwrap_or(0),
                    ":weight" => f.weight.as_deref().and_then(|w| style_value(WEIGHTS, w)).unwrap_or(0),
                    ":slant" => f.slant.as_deref().and_then(|s| style_value(SLANTS, s)).unwrap_or(0),
                    _ => 0,
                })
                .collect();
            key.push(0);
            (key, f.family.clone())
        };
        fonts.sort_by_key(key);
        fonts
            .into_iter()
            .map(|f| {
                let sym = |s: &Option<String>| s.as_ref().map_or(Value::Null, |s| Value::Symbol(s.clone()));
                Value::List(vec![
                    f.family.clone().map_or(Value::Null, Value::Str),
                    sym(&f.width),
                    Value::Number(0.0),
                    sym(&f.weight),
                    sym(&f.slant),
                    Value::Bool(f.spacing.is_some_and(|s| s != PROPORTIONAL)),
                    Value::Str(f.xlfd_name(true)),
                    sym(&f.registry),
                ])
            })
            .collect()
    }

    /// Whether a font has a glyph for a character, as `font-has-char-p`.
    pub fn font_has_char_p(&self, font: &Font, c: char) -> bool {
        let family = font.family.clone();
        let spec = FontSpec { family: family.filter(|f| !crate::faces::is_fixed_family(f)), scale: 1.0, ..FontSpec::default() };
        self.metrics.has_glyph(&spec, c)
    }

    /// Whether the default face's font, or one it falls back on, can show
    /// a character, as `char-displayable-p`. A terminal shows anything.
    pub fn char_displayable_p(&self, c: char) -> bool {
        self.metrics.has_glyph(&self.face_font_spec(&["default".to_string()]), c)
    }
}
