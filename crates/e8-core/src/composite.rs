//! Compositions, as Emacs's composite.c: a `composition` text property
//! that shows a stretch of text as other characters, as
//! `prettify-symbols-mode` shows `lambda` as `λ`.
//!
//! The property is Emacs's `((LENGTH . COMPONENTS) . MODIFICATION-FUNC)`,
//! with conses as two-element lists: `[[LENGTH, COMPONENTS], MODFUNC]`, or
//! `[[LENGTH, COMPONENTS]]` without a function and `[[LENGTH]]` without
//! components. COMPONENTS is a character, a string, or a vector of
//! characters and composition rules.

use crate::buffer::Buffer;
use crate::properties::Text;
use crate::variables::Value;

/// A composition found at a position, as find-composition-internal gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct Composition {
    pub start: usize,
    pub end: usize,
    /// The property, or `None` when its length does not match the text it covers.
    pub prop: Option<Value>,
}

/// What a composition's property says, once checked.
#[derive(Clone, Debug, PartialEq)]
pub struct CompositionDetail {
    /// The components as a vector of characters and encoded rules, or the
    /// covered text when the property names none.
    pub components: Value,
    /// Whether the characters are composed relative to each other rather than by rules.
    pub relative: bool,
    pub modfunc: Value,
    /// The columns it takes.
    pub width: usize,
}

/// The reference points of a composition rule, in the order Emacs numbers them.
const POINTS: [&str; 12] = ["tl", "tc", "tr", "Bl", "Bc", "Br", "bl", "bc", "br", "cl", "cc", "cr"];

/// A composition rule as the number Emacs encodes it to: `(GREF . NREF)`
/// is GREF * 12 + NREF, and a number is itself.
fn encode_rule(rule: &Value) -> Option<Value> {
    match rule {
        Value::Number(_) => Some(rule.clone()),
        Value::List(pair) if pair.len() == 2 => {
            let point = |v: &Value| v.as_str().and_then(|s| POINTS.iter().position(|p| *p == s));
            Some(Value::Number((point(&pair[0])? * 12 + point(&pair[1])?) as f64))
        }
        _ => None,
    }
}

/// The property compose-region-internal puts on LENGTH characters: the
/// components as given, a rule vector's rules encoded.
pub fn composition_property(length: usize, components: Option<Value>, modfunc: Option<Value>) -> Value {
    let components = components.filter(|c| !c.is_nil()).map(|c| match c {
        Value::List(items) => {
            Value::List(items.iter().enumerate().map(|(i, v)| if i % 2 == 1 { encode_rule(v).unwrap_or_else(|| v.clone()) } else { v.clone() }).collect())
        }
        other => other,
    });
    let head = match components {
        Some(c) => Value::List(vec![Value::Number(length as f64), c]),
        None => Value::List(vec![Value::Number(length as f64)]),
    };
    match modfunc.filter(|f| !f.is_nil()) {
        Some(f) => Value::List(vec![head, f]),
        None => Value::List(vec![head]),
    }
}

fn parts(prop: &Value) -> Option<(usize, Option<&Value>, Option<&Value>)> {
    let Value::List(outer) = prop else { return None };
    let Value::List(head) = outer.first()? else { return None };
    let length = head.first()?.as_number()?;
    if length < 1.0 {
        return None;
    }
    Some((length as usize, head.get(1).filter(|c| !c.is_nil()), outer.get(1).filter(|f| !f.is_nil())))
}

/// Whether a property covering `start..end` is a composition of that length.
pub fn composition_valid(start: usize, end: usize, prop: &Value) -> bool {
    parts(prop).is_some_and(|(length, components, _)| {
        length == end - start
            && match components {
                None | Some(Value::Number(_)) | Some(Value::Str(_)) | Some(Value::Text(_)) => true,
                Some(Value::List(items)) => !items.is_empty() && items.len() % 2 == 1,
                _ => false,
            }
    })
}

/// The detail of a valid composition, `text` being the characters it covers.
pub fn composition_detail(prop: &Value, text: &str) -> Option<CompositionDetail> {
    let (_, components, modfunc) = parts(prop)?;
    let char_width = |c: char| crate::display::display_width(&c.to_string(), 8).max(1);
    let (components, relative, chars): (Value, bool, Vec<char>) = match components {
        None => (Value::Str(text.to_string()), true, text.chars().collect()),
        Some(Value::Number(n)) => {
            let c = char::from_u32(*n as u32)?;
            (Value::List(vec![Value::Number(*n)]), true, vec![c])
        }
        Some(Value::Str(_)) | Some(Value::Text(_)) => {
            let s = components?.as_str()?;
            (Value::List(s.chars().map(|c| Value::Number(c as u32 as f64)).collect()), true, s.chars().collect())
        }
        Some(Value::List(items)) => {
            let chars = items.iter().step_by(2).filter_map(|v| char::from_u32(v.as_number()? as u32)).collect();
            (Value::List(items.clone()), false, chars)
        }
        _ => return None,
    };
    let width = chars.iter().map(|&c| char_width(c)).max().unwrap_or(1);
    Some(CompositionDetail { components, relative, modfunc: modfunc.cloned().unwrap_or(Value::Null), width })
}

/// The text a composition is drawn as: its components' characters, or
/// the first character of the text it covers when it names none. Emacs
/// draws relative components on top of each other; here the first stands
/// for them all.
pub fn composition_glyphs(prop: &Value, text: &str) -> Option<String> {
    let (_, components, _) = parts(prop)?;
    let first = match components {
        None => text.chars().next(),
        Some(Value::Number(n)) => char::from_u32(*n as u32),
        Some(Value::List(items)) => items.first().and_then(|v| char::from_u32(v.as_number()? as u32)),
        Some(c) => c.as_str()?.chars().next(),
    }?;
    Some(first.to_string())
}

/// Where the same composition property runs, around `pos`, for a property
/// that runs over `run`: equal properties next to each other run together
/// here, where Emacs tells them apart by identity, so the run is cut into
/// the property's length from its start.
fn split_run(pos: usize, run: (usize, usize), prop: &Value) -> (usize, usize) {
    let Some((length, ..)) = parts(prop) else { return run };
    let k = (pos - run.0) / length;
    let start = run.0 + k * length;
    (start, (start + length).min(run.1))
}

impl Buffer {
    pub(crate) fn composition_at(&self, pos: usize) -> Option<Composition> {
        let prop = self.text_property(pos, "composition")?.clone();
        let start = if pos == 0 { 0 } else { self.previous_single_property_change(pos + 1, "composition", Some(0)).unwrap_or(0) };
        let end = self.next_single_property_change(pos, "composition", None).unwrap_or(self.len());
        let (start, end) = split_run(pos, (start, end), &prop);
        let valid = composition_valid(start, end, &prop);
        Some(Composition { start, end, prop: valid.then_some(prop) })
    }

    /// The composition at `pos`, or else the nearest one between it and
    /// `limit`, as Emacs's find_composition.
    pub fn find_composition(&self, pos: usize, limit: Option<usize>) -> Option<Composition> {
        if let Some(c) = self.composition_at(pos) {
            return Some(c);
        }
        let limit = limit.filter(|&l| l != pos)?;
        if limit > pos {
            let next = self.next_single_property_change(pos, "composition", Some(limit))?;
            if next >= limit {
                return None;
            }
            self.composition_at(next)
        } else {
            if pos > 0
                && let Some(c) = self.composition_at(pos - 1)
            {
                return Some(c);
            }
            let previous = self.previous_single_property_change(pos, "composition", Some(limit))?;
            if previous <= limit {
                return None;
            }
            self.composition_at(previous - 1)
        }
    }
}

/// The composition at or nearest `pos` in a string, as find_composition does for one.
pub fn find_string_composition(text: &Text, pos: usize, limit: Option<usize>) -> Option<Composition> {
    let at = |i: usize| -> Option<Composition> {
        let (range, props) = text.props.iter().find(|(r, p)| r.contains(&i) && p.contains_key("composition"))?;
        let prop = props.get("composition")?.clone();
        // Neighbouring runs with the same value continue it.
        let same = |r: &std::ops::Range<usize>| text.props.iter().find(|(q, _)| q == r).and_then(|(_, p)| p.get("composition")) == Some(&prop);
        let mut start = range.start;
        while let Some((r, _)) = text.props.iter().find(|(r, _)| r.end == start && same(r)) {
            start = r.start;
        }
        let mut end = range.end;
        while let Some((r, _)) = text.props.iter().find(|(r, _)| r.start == end && same(r)) {
            end = r.end;
        }
        let (start, end) = split_run(i, (start, end), &prop);
        let valid = composition_valid(start, end, &prop);
        Some(Composition { start, end, prop: valid.then_some(prop) })
    };
    if let Some(c) = at(pos) {
        return Some(c);
    }
    let limit = limit.filter(|&l| l != pos)?;
    if limit > pos { (pos + 1..limit).find_map(at) } else { (limit..pos).rev().find_map(at) }
}

/// Composition rules sorted by how far back they look, furthest first, as
/// composition-sort-rules: each rule is a vector whose second element is
/// that distance.
pub fn sort_rules(mut rules: Vec<Value>) -> Vec<Value> {
    let lookback = |v: &Value| match v {
        Value::List(items) => items.get(1).and_then(Value::as_number).unwrap_or(0.0),
        _ => 0.0,
    };
    rules.sort_by(|a, b| lookback(b).total_cmp(&lookback(a)));
    rules
}
