//! Compositions, as Emacs's composite.c gives them (ADR 0092): a
//! `composition` text property showing a stretch of text as other
//! characters, put by composeRegionInternal and found by
//! findCompositionInternal.

use crate::*;
use crate::natives::{Opt, natives};
use e8_core::composite;

fn given(value: Opt<EditorValue>) -> Option<EditorValue> {
    value.0.filter(|v| !v.is_nil())
}

fn position(value: &EditorValue, what: &str) -> Result<usize> {
    match value.as_number() {
        Some(n) if n >= 0.0 => Ok(n as usize),
        _ => Err(e8_core::xfaces::wrong_type(what, value)),
    }
}

fn as_text(value: &EditorValue) -> Result<e8_core::Text> {
    match value {
        EditorValue::Str(s) => Ok(e8_core::Text { string: s.clone(), props: Vec::new() }),
        EditorValue::Text(t) => Ok(t.clone()),
        other => Err(e8_core::xfaces::wrong_type("stringp", other)),
    }
}

/// find-composition-internal's answer for a composition covering `text`.
fn answer(found: composite::Composition, text: &str, detail: bool) -> EditorValue {
    let (start, end) = (EditorValue::Number(found.start as f64), EditorValue::Number(found.end as f64));
    let Some(prop) = found.prop else { return EditorValue::List(vec![start, end, EditorValue::Null]) };
    if !detail {
        return EditorValue::List(vec![start, end, EditorValue::Bool(true)]);
    }
    match composite::composition_detail(&prop, text) {
        Some(d) => EditorValue::List(vec![start, end, d.components, EditorValue::Bool(d.relative), d.modfunc, EditorValue::Number(d.width as f64)]),
        None => EditorValue::List(vec![start, end]),
    }
}

natives! {
    /// Compose the text from start to end, as compose-region-internal: put a `composition` property showing it as `components` (a character, a string, or characters and composition rules alternating), or as itself drawn together with none; `modfunc` is called when the text changes.
    #[ts = "(start: number, end: number, components?: number | string | Value[] | null, modfunc?: Value | null): void"]
    pub fn composeRegionInternal(ed, start: usize, end: usize, components: Opt<EditorValue>, modfunc: Opt<EditorValue>) {
        let (start, end) = (start.min(end), start.max(end));
        let prop = composite::composition_property(end - start, given(components), given(modfunc));
        ed.buffer_mut().change_text_property(start..end, "composition", Some(prop));
        Ok(())
    }

    /// The string with the characters from start to end composed, as compose-string-internal; Emacs changes the string itself, which a script's strings cannot be.
    #[ts = "(string: string | Value, start: number, end: number, components?: number | string | Value[] | null, modfunc?: Value | null): Value"]
    pub fn composeStringInternal(_ed, string: EditorValue, start: usize, end: usize, components: Opt<EditorValue>, modfunc: Opt<EditorValue>) -> EditorValue {
        let mut text = as_text(&string)?;
        let (start, end) = (start.min(end), start.max(end));
        if end > text.string.chars().count() {
            return Err(e8_core::Error::signal("args-out-of-range", "Args out of range", Vec::new()));
        }
        let prop = composite::composition_property(end - start, given(components), given(modfunc));
        text.put_property(start..end, "composition", prop);
        Ok(EditorValue::Text(text))
    }

    /// The composition at pos, or the nearest between it and limit, as find-composition-internal: [start, end, true], [start, end, null] when its property is not a valid one, or with detail [start, end, components, relative, modfunc, width]; undefined if there is none.
    #[ts = "(pos: number, limit?: number | null, string?: string | Value | null, detail?: boolean | null): Value[] | undefined"]
    pub fn findCompositionInternal(ed, pos: usize, limit: Opt<EditorValue>, string: Opt<EditorValue>, detail: Opt<EditorValue>) -> Option<EditorValue> {
        let limit = match given(limit) {
            Some(l) => Some(position(&l, "integer-or-marker-p")?),
            None => None,
        };
        let detail = given(detail).is_some_and(|d| d.is_true());
        Ok(match given(string) {
            Some(s) => {
                let text = as_text(&s)?;
                if pos > text.string.chars().count() {
                    return Err(e8_core::Error::signal("args-out-of-range", "Args out of range", Vec::new()));
                }
                composite::find_string_composition(&text, pos, limit).map(|found| {
                    let covered: String = text.string.chars().skip(found.start).take(found.end - found.start).collect();
                    answer(found, &covered, detail)
                })
            }
            None => {
                let b = ed.buffer();
                if pos > b.len() {
                    return Err(e8_core::Error::signal("args-out-of-range", "Args out of range", Vec::new()));
                }
                b.find_composition(pos, limit).map(|found| {
                    let covered = b.slice(found.start..found.end);
                    answer(found, &covered, detail)
                })
            }
        })
    }

    /// The glyph string for the text from `from` to `to`, as composition-get-gstring: [[font, chars...], null, glyphs...], each glyph [from, to, char, code, width, lbearing, rbearing, ascent, descent] counting from 0 in the text; E8 shapes nothing, so each character is a glyph of its own.
    #[ts = "(from: number, to: number, fontObject: Value, string?: string | Value | null): Value[]"]
    pub fn compositionGetGstring(ed, from: usize, to: usize, font_object: EditorValue, string: Opt<EditorValue>) -> EditorValue {
        let (from, to) = (from.min(to), from.max(to));
        let chars: Vec<char> = match given(string) {
            Some(s) => as_text(&s)?.string.chars().skip(from).take(to - from).collect(),
            None => {
                let b = ed.buffer();
                b.slice(from.min(b.len())..to.min(b.len())).chars().collect()
            }
        };
        let mut header = vec![font_object];
        header.extend(chars.iter().map(|&c| EditorValue::Number(c as u32 as f64)));
        let mut gstring = vec![EditorValue::List(header), EditorValue::Null];
        for (i, &c) in chars.iter().enumerate() {
            let width = e8_core::display::display_width(&c.to_string(), 8) as f64;
            let n = |x: f64| EditorValue::Number(x);
            gstring.push(EditorValue::List(vec![n(i as f64), n(i as f64), n(c as u32 as f64), n(c as u32 as f64), n(width), n(0.0), n(width), n(1.0), n(0.0)]));
        }
        Ok(EditorValue::List(gstring))
    }

    /// Forget the glyph strings worked out for compositions, as clear-composition-cache; E8 keeps none.
    #[ts = "(): void"]
    pub fn clearCompositionCache(_ed) {
        Ok(())
    }

    /// Composition rules sorted by how far back each looks, its second element, furthest first, as composition-sort-rules.
    #[ts = "(rules: Value[][]): Value[][]"]
    pub fn compositionSortRules(_ed, rules: Vec<EditorValue>) -> Vec<EditorValue> {
        Ok(composite::sort_rules(rules))
    }
}
