//! Fontsets, as Emacs's fontset.c: named lists of which fonts to show
//! characters in, by range, script or charset (ADR 0085). `set-fontset-font`
//! changes one, `fontset-font` asks which fonts one gives a character,
//! `new-fontset` makes one and `fontset-list` and `query-fontset` find
//! them. A font is kept as Emacs's pattern for it, `(FAMILY . REGISTRY)`,
//! which scripts see as `[family, registry]`. The front ends do not draw
//! with fontsets yet: the GUI falls back on its own fonts.

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::font::{Font, FontKind};
use crate::variables::Value;
use crate::xfaces::is_nil;

/// The default fontset's name, as Emacs names it.
pub const DEFAULT_FONTSET: &str = "-*-*-*-*-*-*-*-*-*-*-*-*-fontset-default";

/// Which characters an entry of a fontset is for.
#[derive(Clone, Debug, PartialEq)]
enum Target {
    Range(u32, u32),
    Script(String),
    Charset(String),
    /// Any character no other entry is for, as nil.
    Default,
}

#[derive(Clone, Debug)]
pub struct Fontset {
    name: String,
    /// Entries, the newest first; each font a pattern or nil for none.
    entries: Vec<(Target, Vec<Value>)>,
}

/// The fontsets, newest first, the default last.
#[derive(Clone, Debug)]
pub struct Fontsets(Vec<Fontset>);

impl Default for Fontsets {
    fn default() -> Fontsets {
        Fontsets(vec![Fontset { name: DEFAULT_FONTSET.to_string(), entries: Vec::new() }])
    }
}

fn error(message: impl Into<String>) -> Error {
    Error::new(message)
}

fn char_of(value: &Value) -> Result<u32> {
    value
        .as_number()
        .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= 0x3F_FFFF as f64)
        .map(|n| n as u32)
        .ok_or_else(|| crate::xfaces::wrong_type("characterp", value))
}

/// A character's script, as `char-script-table` gives it.
pub fn script_of(c: u32) -> Option<&'static str> {
    let table = crate::chartab_data::SCRIPT;
    let i = table.partition_point(|&(_, last, _)| last < c);
    table.get(i).filter(|&&(first, _, _)| first <= c).map(|&(_, _, s)| crate::chartab_data::SCRIPT_NAMES[s as usize])
}

fn is_script(name: &str) -> bool {
    crate::chartab_data::SCRIPT_NAMES.contains(&name) && name != "nil"
}

/// A font as a fontset keeps it: a spec, `(FAMILY . REGISTRY)` or a name,
/// as `set-fontset-font` takes it, made `[family, registry]`; nil for none.
fn font_pattern(spec: &Value) -> Result<Value> {
    let pattern = |font: &Font| {
        let family = font.family.clone().map_or(Value::Null, Value::Str);
        let registry = font.registry.clone().map_or(Value::Null, |r| Value::Str(r.to_lowercase()));
        Value::List(vec![family, registry])
    };
    match spec {
        v if is_nil(v) => Ok(Value::Null),
        Value::Font(font) if font.kind == FontKind::Spec => Ok(pattern(font)),
        Value::Str(name) => Ok(crate::font::font_spec_from_name(name).map_or_else(|| Value::List(vec![Value::Str(name.clone()), Value::Null]), |f| pattern(&f))),
        Value::List(pair) if pair.len() == 2 && pair.iter().all(|v| is_nil(v) || v.as_str().is_some()) => {
            let family = pair[0].as_str().map_or(Value::Null, |s| Value::Str(s.to_string()));
            let registry = pair[1].as_str().map_or(Value::Null, |s| Value::Str(s.to_lowercase()));
            Ok(Value::List(vec![family, registry]))
        }
        other => Err(Error::signal("font", "Invalid font-spec", vec![Value::Str("Invalid font-spec".into()), other.clone()])),
    }
}

impl Fontset {
    /// The fonts this fontset gives a character, the best first.
    fn fonts_for(&self, c: u32) -> Vec<Value> {
        let script = script_of(c);
        let char = char::from_u32(c);
        let applies = |target: &Target| match target {
            Target::Range(from, to) => (*from..=*to).contains(&c),
            Target::Script(name) => script == Some(name.as_str()),
            Target::Charset(name) => char.is_some_and(|ch| crate::charset::encode_char(ch, name).is_some()),
            Target::Default => false,
        };
        let found = self.entries.iter().find(|(t, _)| applies(t)).or_else(|| self.entries.iter().find(|(t, _)| *t == Target::Default));
        found.map(|(_, fonts)| fonts.clone()).unwrap_or_default()
    }

    fn add(&mut self, target: Target, font: Value, add: Option<&str>) {
        match self.entries.iter_mut().find(|(t, _)| *t == target) {
            Some((_, fonts)) => match add {
                Some("prepend") => fonts.insert(0, font),
                Some("append") => fonts.push(font),
                _ => *fonts = vec![font],
            },
            None => self.entries.insert(0, (target, vec![font])),
        }
    }
}

impl Editor {
    /// The fontsets' names, as `fontset-list`, the newest first.
    pub fn fontset_list(&self) -> Vec<String> {
        self.fontsets.0.iter().map(|f| f.name.clone()).collect()
    }

    /// The name of the fontset a pattern matches, as `query-fontset`: a
    /// name, ignoring case, a short name such as `fontset-default`, a
    /// pattern with `*` and `?`, or with REGEXP an Emacs regexp.
    pub fn query_fontset(&self, pattern: &str, regexp: bool) -> Option<String> {
        if pattern.is_empty() {
            return None;
        }
        let lower = pattern.to_lowercase();
        let matches = |name: &str| {
            let name_lower = name.to_lowercase();
            if regexp {
                self.string_match(&lower, &name_lower, 0, true).ok().flatten().is_some()
            } else if lower.contains(['*', '?']) {
                crate::font::xlfd_matches(&lower, &name_lower)
            } else {
                name_lower == lower || (!lower.starts_with('-') && name_lower.ends_with(&format!("-{lower}")))
            }
        };
        self.fontsets.0.iter().find(|f| matches(&f.name)).map(|f| f.name.clone())
    }

    /// The fontset FONTSET names: t or nil for the default, else its name.
    fn fontset_index(&self, fontset: &Value) -> Result<usize> {
        match fontset {
            v if is_nil(v) || matches!(v, Value::Bool(true)) => Ok(self.fontsets.0.len() - 1),
            Value::Str(name) => {
                let found = self.query_fontset(name, false);
                found.and_then(|n| self.fontsets.0.iter().position(|f| f.name == n)).ok_or_else(|| error(format!("Fontset ‘{name}’ does not exist")))
            }
            other => Err(crate::xfaces::wrong_type("stringp", other)),
        }
    }

    /// Makes FONTSET give FONT for CHARACTERS, as `set-fontset-font`: a
    /// character from U+0080, a range `[from, to]`, a script, a charset, or
    /// nil for the rest; ADD `prepend` or `append` keeps the fonts it gave.
    pub fn set_fontset_font(&mut self, fontset: &Value, characters: &Value, font: &Value, add: &Value) -> Result<()> {
        let index = self.fontset_index(fontset)?;
        let pattern = font_pattern(font)?;
        let (target, ascii) = match characters {
            Value::Number(_) => {
                let c = char_of(characters)?;
                if c < 0x80 {
                    return Err(error("Can’t set a font for partial ASCII range"));
                }
                (Target::Range(c, c), false)
            }
            Value::List(pair) if pair.len() == 2 => {
                let (from, to) = (char_of(&pair[0])?, char_of(&pair[1])?);
                if from < 0x80 && (from != 0 || to < 0x7F) {
                    return Err(error("Can’t set a font for partial ASCII range"));
                }
                (Target::Range(from, to), from < 0x80)
            }
            Value::Symbol(name) if is_script(name) => (Target::Script(name.clone()), name == "latin"),
            Value::Symbol(name) if crate::charset::charsetp(name) => {
                let ascii = char::from_u32(0x41).and_then(|c| crate::charset::encode_char(c, name)) == Some(0x41);
                (Target::Charset(name.clone()), ascii)
            }
            Value::Symbol(name) => return Err(error(format!("Invalid script or charset name: {name}"))),
            v if is_nil(v) => (Target::Default, false),
            _ => return Err(error("Invalid second argument for setting a font in a fontset")),
        };
        if ascii && is_nil(&pattern) {
            return Err(error("Can’t set ASCII font to nil"));
        }
        let add = add.as_str().filter(|a| matches!(*a, "prepend" | "append"));
        self.fontsets.0[index].add(target, pattern, add);
        Ok(())
    }

    /// The fonts FONTSET gives a character, as `fontset-font`: the first,
    /// or with ALL every one, each `[family, registry]`; none if it gives none.
    /// What a fontset holds, as `fontset-info`: a char-table of subtype
    /// `fontset-info` whose values are `((FONT OPENED-FONT ...) ...)`, a
    /// list for each font a range of characters is given. E8's front ends
    /// do not draw with fontsets, so no font is opened and each list holds
    /// the font alone. Its extra slot is the default fontset's table for a
    /// fontset that is not the default, as Emacs's is. Only on a window system.
    pub fn fontset_info(&mut self, fontset: &Value) -> Result<Value> {
        if self.window_system().is_none() {
            return Err(Error::signal("error", "Window system is not in use or not initialized", Vec::new()));
        }
        let index = self.fontset_index(fontset)?;
        // The default fontset is the last; new ones go in front of it.
        let default_index = self.fontsets.0.len() - 1;
        let table = self.fontset_info_table(index)?;
        if index != default_index {
            let default = self.fontset_info_table(default_index)?;
            self.set_char_table_extra_slot(table, 0, Value::CharTable(default))?;
        }
        Ok(Value::CharTable(table))
    }

    fn fontset_info_table(&mut self, index: usize) -> Result<crate::chartab::CharTableId> {
        if self.get("fontset-info", "char-table-extra-slots").is_none() {
            self.put("fontset-info", "char-table-extra-slots", Value::Number(1.0));
        }
        let table = self.make_char_table("fontset-info", Value::Null)?;
        let entries = self.fontsets.0[index].entries.clone();
        // Earlier entries win, as fonts_for looks them up, so the last are set first.
        for (target, fonts) in entries.iter().rev() {
            let value = Value::List(fonts.iter().filter(|f| !is_nil(f)).map(|f| Value::List(vec![f.clone()])).collect());
            let ranges: Vec<(u32, u32)> = match target {
                Target::Range(from, to) => vec![(*from, *to)],
                Target::Script(name) => crate::chartab_data::SCRIPT
                    .iter()
                    .filter(|&&(_, _, s)| crate::chartab_data::SCRIPT_NAMES[s as usize] == name)
                    .map(|&(first, last, _)| (first, last))
                    .collect(),
                Target::Charset(name) => crate::charset::charset_char_ranges(name, None, None)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(a, b)| (a as u32, b as u32))
                    .collect(),
                Target::Default => {
                    self.set_char_table_range(table, crate::chartab::CharRange::Default, value.clone())?;
                    Vec::new()
                }
            };
            for (from, to) in ranges {
                self.set_char_table_range(table, crate::chartab::CharRange::Range(from, to), value.clone())?;
            }
        }
        Ok(table)
    }

    pub fn fontset_font(&self, fontset: &Value, c: &Value, all: bool) -> Result<Value> {
        let index = self.fontset_index(fontset)?;
        let fonts: Vec<Value> = self.fontsets.0[index].fonts_for(char_of(c)?).into_iter().filter(|f| !is_nil(f)).collect();
        Ok(if all { Value::List(fonts) } else { fonts.into_iter().next().unwrap_or(Value::Null) })
    }

    /// Makes a fontset, or remakes one, as `new-fontset`: its name an XLFD
    /// name, its fonts an alist of what `set-fontset-font` takes, as
    /// `[target, font]` pairs. Gives its name.
    pub fn new_fontset(&mut self, name: &str, fonts: &Value) -> Result<String> {
        if !name.starts_with('-') || name.matches('-').count() != 14 {
            return Err(error("Fontset name must be in XLFD format"));
        }
        let existing = self.fontsets.0.iter().position(|f| f.name.eq_ignore_ascii_case(name));
        let fontset = Fontset { name: name.to_string(), entries: Vec::new() };
        let index = match existing {
            Some(i) => {
                self.fontsets.0[i] = fontset;
                i
            }
            None => {
                self.fontsets.0.insert(0, fontset);
                0
            }
        };
        let entries = match fonts {
            Value::List(items) => items.clone(),
            _ => Vec::new(),
        };
        let name_value = Value::Str(self.fontsets.0[index].name.clone());
        for entry in &entries {
            let Value::List(pair) = entry else { continue };
            let (Some(target), Some(font)) = (pair.first(), pair.get(1)) else { continue };
            // ASCII is the fontset's own font, for characters below U+0080.
            let target = match target {
                Value::Symbol(s) if s == "ascii" => Value::List(vec![Value::Number(0.0), Value::Number(127.0)]),
                other => other.clone(),
            };
            self.set_fontset_font(&name_value, &target, font, &Value::Symbol("append".into()))?;
        }
        Ok(self.fontsets.0[index].name.clone())
    }
}
