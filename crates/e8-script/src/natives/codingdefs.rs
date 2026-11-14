//! Defining coding systems, as coding.c's `define-coding-system-internal`
//! and `define-coding-system-alias` (ADR 0094), and the rest of coding.c's
//! primitives E8 lacked.

use crate::*;
use crate::natives::{Opt, Rest, natives};
use e8_core::coding::{self, Definition, Eol};

fn name_of(value: &EditorValue, what: &str) -> Result<String> {
    value.as_str().map(str::to_string).ok_or_else(|| e8_core::xfaces::wrong_type(what, value))
}

/// A plist's value for a key, `:mime-charset` and its kin.
fn plist_get<'a>(plist: &'a EditorValue, key: &str) -> Option<&'a EditorValue> {
    let EditorValue::List(items) = plist else { return None };
    items.chunks(2).find(|p| p[0].as_str() == Some(key)).and_then(|p| p.get(1))
}

/// Emacs's positions in define-coding-system-internal's arguments, as coding.h's coding_arg_index.
const NAME: usize = 0;
const MNEMONIC: usize = 1;
const TYPE: usize = 2;
const CHARSETS: usize = 3;
const PLIST: usize = 11;
const EOL_TYPE: usize = 12;
/// Where a type's own arguments start, coding_arg_max.
const TYPE_ARGS: usize = 13;

natives! {
    /// Define a coding system from Emacs's arguments in their order, as define-coding-system-internal: name, mnemonic, coding type, charset list, ASCII compatibility, translation tables, conversions, default character, for-unibyte, plist, eol type, then the type's own (UTF-8's bom; UTF-16's bom and endianness). E8 writes utf-8, utf-16, raw-text, undecided and charset codings, and others through their charsets.
    #[ts = "(...args: Value[]): undefined"]
    pub fn defineCodingSystemInternal(_ed, args: Rest<EditorValue>) -> Option<bool> {
        let args = args.0;
        if args.len() < TYPE_ARGS {
            return Err(Error::signal("wrong-number-of-arguments", "Wrong number of arguments", vec![EditorValue::Number(args.len() as f64)]));
        }
        let name = name_of(&args[NAME], "symbolp")?;
        let mnemonic = match &args[MNEMONIC] {
            EditorValue::Number(n) => char::from_u32(*n as u32).unwrap_or('-'),
            other => other.as_str().and_then(|s| s.chars().next()).unwrap_or('-'),
        };
        let coding_type = name_of(&args[TYPE], "symbolp")?;
        let charsets = match &args[CHARSETS] {
            EditorValue::List(items) => items.iter().map(|c| name_of(c, "charsetp")).collect::<Result<Vec<_>>>()?,
            EditorValue::Null => Vec::new(),
            // A symbol such as iso-2022 names the charsets of that kind; E8 knows none by it.
            _ => Vec::new(),
        };
        let eol = match args[EOL_TYPE].as_str() {
            Some("unix") => Some(Eol::Unix),
            Some("dos") => Some(Eol::Dos),
            Some("mac") => Some(Eol::Mac),
            _ => match &args[EOL_TYPE] {
                EditorValue::Number(n) => Eol::from_number(*n as u8),
                _ => None,
            },
        };
        let plist = &args[PLIST];
        let bom = match args.get(TYPE_ARGS) {
            None | Some(EditorValue::Null) => Some(false),
            Some(EditorValue::List(_)) => None,
            Some(_) => Some(true),
        };
        let big_endian = !matches!(args.get(TYPE_ARGS + 1).and_then(EditorValue::as_str), Some("little"));
        let aliases = match plist_get(plist, ":aliases") {
            Some(EditorValue::List(items)) => items.iter().filter_map(|a| a.as_str().map(str::to_string)).filter(|a| *a != name).collect(),
            _ => Vec::new(),
        };
        let definition = Definition {
            name,
            mnemonic,
            coding_type,
            charsets,
            mime_charset: plist_get(plist, ":mime-charset").and_then(EditorValue::as_str).map(str::to_string),
            eol,
            bom,
            big_endian,
            aliases,
        };
        coding::define_system(&definition).map_err(|m| Error::signal("error", m, Vec::new()))?;
        Ok(None)
    }

    /// Give a coding system another name, as define-coding-system-alias.
    #[ts = "(alias: CodingSystem, codingSystem: CodingSystem): undefined"]
    pub fn defineCodingSystemAlias(_ed, alias: EditorValue, coding_system: EditorValue) -> Option<bool> {
        let alias = name_of(&alias, "symbolp")?;
        let target = name_of(&coding_system, "symbolp")?;
        coding::define_alias(&alias, &target).map_err(|name| e8_core::codingfns::coding_system_error(&name))?;
        Ok(None)
    }

    /// The base coding systems that can write the text from `from` to `to`, or of the string `from`, leaving out those in `exclude`, as find-coding-systems-region-internal: true where the text is all ASCII.
    #[ts = "(from: number | string, to: number | null, exclude?: CodingSystem[] | null): CodingSystem[] | true"]
    pub fn findCodingSystemsRegionInternal(ed, from: EditorValue, to: EditorValue, exclude: Opt<EditorValue>) -> EditorValue {
        let text = match &from {
            EditorValue::Str(s) => s.clone(),
            EditorValue::Text(t) => t.string.clone(),
            EditorValue::Number(start) => {
                let end = to.as_number().ok_or_else(|| e8_core::xfaces::wrong_type("integer-or-marker-p", &to))?;
                ed.region_text(*start as usize, end as usize)?
            }
            other => return Err(e8_core::xfaces::wrong_type("integer-or-marker-p", other)),
        };
        if text.chars().all(|c| c.is_ascii() || e8_core::coding::char_raw_byte(c).is_some()) {
            return Ok(EditorValue::Bool(true));
        }
        let excluded: Vec<String> = match exclude.0 {
            Some(EditorValue::List(items)) => items.iter().filter_map(|c| c.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        let found = e8_core::coding::Coding::base_systems()
            .filter(|c| !c.is_undecided())
            .filter(|c| !excluded.iter().any(|x| x == c.system().name))
            .filter(|c| text.chars().all(|ch| c.can_encode(ch)))
            .map(|c| EditorValue::Str(c.system().name.to_string()))
            .collect();
        Ok(EditorValue::List(found))
    }

    /// Set the coding system for writing to the terminal when it is safe, as set-safe-terminal-coding-system-internal: E8's terminal writes UTF-8, so the coding is checked and kept in safe-terminal-coding-system.
    #[ts = "(codingSystem: CodingSystem | null): undefined"]
    pub fn setSafeTerminalCodingSystemInternal(ed, coding_system: EditorValue) -> Option<bool> {
        if !coding_system.is_nil() {
            let name = name_of(&coding_system, "symbolp")?;
            e8_core::codingfns::check_coding_system(&name)?;
        }
        ed.set_variable("safe-terminal-coding-system", coding_system);
        Ok(None)
    }
}
