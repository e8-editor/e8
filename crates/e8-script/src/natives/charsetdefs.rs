//! Defining charsets, as charset.c's `define-charset-internal` and its
//! kin (ADR 0095): aliases, ISO 2022's final bytes, and the characters a
//! charset holds.

use crate::*;
use crate::natives::{Opt, Rest, natives};
use e8_core::charset::{self, Definition};

fn wrong(predicate: &str, value: &EditorValue) -> Error {
    e8_core::xfaces::wrong_type(predicate, value)
}

fn name_of(value: &EditorValue, what: &str) -> Result<String> {
    value.as_str().map(str::to_string).ok_or_else(|| wrong(what, value))
}

fn whole(value: &EditorValue) -> Option<u32> {
    value.as_number().filter(|n| *n >= 0.0 && n.fract() == 0.0).map(|n| n as u32)
}

/// A number, or a character given as a one-character string.
fn char_code(value: &EditorValue) -> Option<u32> {
    whole(value).or_else(|| value.as_str().filter(|s| s.chars().count() == 1).and_then(|s| s.chars().next()).map(|c| c as u32))
}

fn charset_error(value: &EditorValue) -> Error {
    wrong("charsetp", value)
}

/// Emacs's positions in define-charset-internal's arguments, as charset.c's define_charset_arg_index.
const NAME: usize = 0;
const CODE_SPACE: usize = 2;
const MIN_CODE: usize = 3;
const MAX_CODE: usize = 4;
const ISO_FINAL: usize = 5;
const CODE_OFFSET: usize = 11;
const SUBSET: usize = 13;
const SUPERSET: usize = 14;
const PLIST: usize = 16;
const ARGS: usize = 17;

natives! {
    /// Define a charset from Emacs's arguments in their order, as define-charset-internal: name, dimension, code space, min and max code, ISO final and revision, emacs-mule id, ASCII compatibility, supplementary, invalid code, code offset, map, subset, superset, unify map and plist. E8 maps codes by :code-offset, :subset and :superset; a :map file it does not read gives no characters.
    #[ts = "(...args: Value[]): undefined"]
    pub fn defineCharsetInternal(ed, args: Rest<EditorValue>) -> Option<bool> {
        let args = args.0;
        if args.len() != ARGS {
            return Err(Error::signal("wrong-number-of-arguments", "Wrong number of arguments", vec![EditorValue::Number(args.len() as f64)]));
        }
        let name = name_of(&args[NAME], "symbolp")?;
        let code_space = match &args[CODE_SPACE] {
            EditorValue::List(items) if items.len() % 2 == 0 && !items.is_empty() => items
                .chunks(2)
                .map(|p| Some((whole(&p[0])?, whole(&p[1])?)))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| wrong("vectorp", &args[CODE_SPACE]))?,
            other => return Err(wrong("vectorp", other)),
        };
        let pair = |value: &EditorValue| -> Option<(String, u32)> {
            match value {
                EditorValue::List(p) if p.len() == 2 => Some((p[0].as_str()?.to_string(), whole(&p[1])?)),
                other => Some((other.as_str()?.to_string(), 0)),
            }
        };
        let subset = match &args[SUBSET] {
            EditorValue::List(p) if p.len() == 4 => Some((name_of(&p[0], "charsetp")?, whole(&p[1]).unwrap_or(0), whole(&p[2]).unwrap_or(0), whole(&p[3]).unwrap_or(0))),
            v if v.is_nil() => None,
            other => return Err(wrong("listp", other)),
        };
        let superset = match &args[SUPERSET] {
            EditorValue::List(items) => Some(items.iter().map(|i| pair(i).ok_or_else(|| wrong("charsetp", i))).collect::<Result<Vec<_>>>()?),
            v if v.is_nil() => None,
            other => return Err(wrong("listp", other)),
        };
        let definition = Definition {
            name: name.clone(),
            code_space,
            min_code: whole(&args[MIN_CODE]),
            max_code: whole(&args[MAX_CODE]),
            iso_final: char_code(&args[ISO_FINAL]).map(|c| c as u8),
            code_offset: char_code(&args[CODE_OFFSET]),
            subset,
            superset,
        };
        charset::define_charset(&definition).map_err(|m| Error::signal("error", m, Vec::new()))?;
        ed.coding_primitive("set-charset-plist", &[EditorValue::Str(name), args[PLIST].clone()])?;
        Ok(None)
    }

    /// Give a charset another name, as define-charset-alias.
    #[ts = "(alias: string, charset: string): undefined"]
    pub fn defineCharsetAlias(_ed, alias: EditorValue, charset: EditorValue) -> Option<bool> {
        let alias = name_of(&alias, "symbolp")?;
        let target = name_of(&charset, "charsetp")?;
        charset::define_alias(&alias, &target).map_err(|()| charset_error(&charset))?;
        Ok(None)
    }

    /// Make a charset the one ISO 2022 names by a dimension, 94 or 96 characters and a final character, as declare-equiv-charset.
    #[ts = "(dimension: number, chars: number, finalChar: number | string, charset: string): undefined"]
    pub fn declareEquivCharset(_ed, dimension: f64, chars: f64, final_char: EditorValue, cs: EditorValue) -> Option<bool> {
        let final_byte = char_code(&final_char).ok_or_else(|| wrong("characterp", &final_char))? as u8;
        let name = name_of(&cs, "charsetp")?;
        charset::declare_equiv_charset(dimension as u32, chars as u32, final_byte, &name).map_err(|()| charset_error(&cs))?;
        Ok(None)
    }

    /// The charset ISO 2022 names by a dimension, 94 or 96 characters and a final character, as iso-charset; undefined if none.
    #[ts = "(dimension: number, chars: number, finalChar: number | string): string | undefined"]
    pub fn isoCharset(_ed, dimension: f64, chars: f64, final_char: EditorValue) -> Option<String> {
        let final_byte = char_code(&final_char).ok_or_else(|| wrong("characterp", &final_char))? as u8;
        Ok(charset::iso_charset(dimension as u32, chars as u32, final_byte).map(str::to_string))
    }

    /// The first of ISO 2022's private final characters, 0 to ?, that no charset of a dimension and 94 or 96 characters has, as get-unused-iso-final-char; undefined if all are taken.
    #[ts = "(dimension: number, chars: number): number | undefined"]
    pub fn getUnusedIsoFinalChar(_ed, dimension: f64, chars: f64) -> Option<f64> {
        if !(1.0..=3.0).contains(&dimension) {
            return Err(Error::signal("error", format!("Invalid DIMENSION {dimension}, it should be 1, 2, or 3"), Vec::new()));
        }
        if chars != 94.0 && chars != 96.0 {
            return Err(Error::signal("error", format!("Invalid CHARS {chars}, it should be 94 or 96"), Vec::new()));
        }
        Ok(charset::unused_iso_final(dimension as u32, chars as u32).map(f64::from))
    }

    /// The ranges of characters a charset's codes from `from` to `to` hold, each [first, last], for map-charset-chars.
    #[ts = "(charset: string, from?: number | null, to?: number | null): [number, number][]"]
    pub fn charsetCharRanges(_ed, cs: EditorValue, from: Opt<EditorValue>, to: Opt<EditorValue>) -> Vec<EditorValue> {
        let name = name_of(&cs, "charsetp")?;
        let code = |v: Option<EditorValue>| v.as_ref().and_then(whole);
        let ranges = charset::charset_char_ranges(&name, code(from.0), code(to.0)).ok_or_else(|| charset_error(&cs))?;
        Ok(ranges.into_iter().map(|(a, b)| EditorValue::List(vec![EditorValue::Number(f64::from(a as u32)), EditorValue::Number(f64::from(b as u32))])).collect())
    }
}
