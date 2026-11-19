//! Unicode character properties, as Emacs's `get-char-code-property`
//! gives them: the names and old names, the canonical combining class,
//! decomposition, digit and numeric values and the simple case mappings,
//! written from Emacs 30.2 by tests/emacs/unidata.el, with the general
//! category, the bidi properties and the special casings E8 already held
//! for its regexps, display and case conversion.

use std::sync::OnceLock;

use crate::unidata_data::*;
use crate::variables::Value;

/// The properties `char-code-property-alist` lists in Emacs 30, in its order.
pub const PROPERTIES: [&str; 20] = [
    "bracket-type",
    "paired-bracket",
    "special-titlecase",
    "special-lowercase",
    "special-uppercase",
    "titlecase",
    "lowercase",
    "uppercase",
    "iso-10646-comment",
    "old-name",
    "mirroring",
    "mirrored",
    "numeric-value",
    "digit-value",
    "decimal-digit-value",
    "decomposition",
    "bidi-class",
    "canonical-combining-class",
    "general-category",
    "name",
];

/// The names, each character's own and its old one, by code.
struct Names {
    names: Vec<(u32, Box<str>)>,
    old: Vec<(u32, Box<str>)>,
}

/// The names, read from unidata_names.txt the first time one is asked for.
fn names() -> &'static Names {
    static NAMES: OnceLock<Names> = OnceLock::new();
    NAMES.get_or_init(|| {
        let text = include_str!("unidata_names.txt");
        let (front, old) = text.split_once("\n%\n").unwrap_or((text, ""));
        let mut names = Vec::with_capacity(33_000);
        let mut code: i64 = -1;
        let mut last = String::new();
        for line in front.lines() {
            let mut parts = line.splitn(3, ';');
            let (Some(delta), Some(shared), Some(rest)) = (parts.next(), parts.next(), parts.next()) else { continue };
            code += if delta.is_empty() { 1 } else { i64::from_str_radix(delta, 16).unwrap_or(1) };
            let shared: usize = shared.parse().unwrap_or(0);
            let mut name = String::with_capacity(shared + rest.len());
            name.push_str(&last[..shared.min(last.len())]);
            name.push_str(rest);
            names.push((code as u32, name.clone().into_boxed_str()));
            last = name;
        }
        let old = old
            .lines()
            .filter_map(|l| {
                let (code, name) = l.split_once(';')?;
                Some((u32::from_str_radix(code, 16).ok()?, name.into()))
            })
            .collect();
        Names { names, old }
    })
}

const JAMO_L: [&str; 19] = ["G", "GG", "N", "D", "DD", "R", "M", "B", "BB", "S", "SS", "", "J", "JJ", "C", "K", "T", "P", "H"];
const JAMO_V: [&str; 21] = ["A", "AE", "YA", "YAE", "EO", "E", "YEO", "YE", "O", "WA", "WAE", "OE", "YO", "U", "WEO", "WE", "WI", "YU", "EU", "YI", "I"];
const JAMO_T: [&str; 28] = [
    "", "G", "GG", "GS", "N", "NJ", "NH", "D", "L", "LG", "LM", "LB", "LS", "LT", "LP", "LH", "M", "B", "BS", "S", "SS", "NG", "J", "C", "K", "T", "P", "H",
];

/// A character's Unicode name, as its `name` property: its own, a Hangul
/// syllable's made from its jamo, or a prefix and its code in hex, as
/// CJK IDEOGRAPH-4E00.
pub fn name(c: u32) -> Option<String> {
    if (0xAC00..=0xD7A3).contains(&c) {
        let s = (c - 0xAC00) as usize;
        return Some(format!("HANGUL SYLLABLE {}{}{}", JAMO_L[s / 588], JAMO_V[(s % 588) / 28], JAMO_T[s % 28]));
    }
    let i = ALGORITHMIC_NAMES.partition_point(|&(_, last, _)| last < c);
    if let Some(&(first, _, prefix)) = ALGORITHMIC_NAMES.get(i).filter(|&&(first, _, _)| first <= c) {
        let _ = first;
        return Some(format!("{prefix}-{c:X}"));
    }
    let names = &names().names;
    names.binary_search_by_key(&c, |(code, _)| *code).ok().map(|i| names[i].1.to_string())
}

/// A character's name before Unicode 2.0, or a control character's, as
/// its `old-name` property.
pub fn old_name(c: u32) -> Option<&'static str> {
    let old = &names().old;
    old.binary_search_by_key(&c, |(code, _)| *code).ok().map(|i| &*old[i].1)
}

/// Every character with a name of its own, not made from its code, and its name, in code order.
pub fn named() -> impl Iterator<Item = (u32, &'static str)> {
    names().names.iter().map(|(c, n)| (*c, &**n))
}

/// Every character with an old name, and the name, in code order.
pub fn old_named() -> impl Iterator<Item = (u32, &'static str)> {
    names().old.iter().map(|(c, n)| (*c, &**n))
}

/// The character a name made from a prefix and a code names, as
/// CJK IDEOGRAPH-4E00 or HANGUL SYLLABLE GA does.
pub fn from_made_name(name: &str) -> Option<u32> {
    if let Some(syllable) = name.strip_prefix("HANGUL SYLLABLE ") {
        return (0xAC00..=0xD7A3).find(|&c| self::name(c).as_deref().and_then(|n| n.strip_prefix("HANGUL SYLLABLE ")) == Some(syllable));
    }
    let (prefix, hex) = name.rsplit_once('-')?;
    let c = u32::from_str_radix(hex, 16).ok()?;
    ALGORITHMIC_NAMES.iter().any(|&(first, last, p)| p == prefix && (first..=last).contains(&c)).then_some(c)
}

/// The code ranges Emacs's `ucs-names` reads names from, leaving out
/// the CJK ideographs, surrogates, private use and Tangut.
const UCS_NAME_RANGES: [(u32, u32); 14] = [
    (0x0000, 0x33FF),
    (0x4DC0, 0x4DFF),
    (0xA000, 0xD7FF),
    (0xFB00, 0x134FF),
    (0x14400, 0x14646),
    (0x16800, 0x16F9F),
    (0x16FE0, 0x16FF1),
    (0x1AFF0, 0x1B122),
    (0x1B132, 0x1B132),
    (0x1B150, 0x1B16F),
    (0x1B170, 0x1B2FF),
    (0x1BC00, 0x1BCAF),
    (0x1CF00, 0x1FFFF),
    (0xE0000, 0xE01FF),
];

/// The names `ucs-names` gives in Emacs, with their characters, in the
/// order its hash table holds them: in its ranges each character's name,
/// a later character with the same name taking it over, its old name
/// unless a name already has it, LAMBDA for LAMDA where it has no old
/// name, and "BELL (BEL)".
pub fn ucs_names() -> Vec<(String, u32)> {
    let mut out: Vec<(String, u32)> = Vec::with_capacity(46_000);
    let mut at: std::collections::HashMap<String, usize> = std::collections::HashMap::with_capacity(46_000);
    let mut put = |out: &mut Vec<(String, u32)>, name: String, c: u32, replace: bool| match at.get(&name) {
        Some(&i) if replace => out[i].1 = c,
        Some(_) => {}
        None => {
            at.insert(name.clone(), out.len());
            out.push((name, c));
        }
    };
    let lamda = |n: &str| -> Option<String> {
        let (i, _) = n.match_indices("LAMDA").find(|&(i, _)| {
            let before = n[..i].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
            let after = n[i + 5..].chars().next().is_none_or(|c| !c.is_alphanumeric());
            before && after
        })?;
        Some(format!("{}LAMBDA{}", &n[..i], &n[i + 5..]))
    };
    for &(first, last) in &UCS_NAME_RANGES {
        for c in first..=last {
            let new = name(c);
            let old = old_name(c);
            if let Some(n) = &new {
                put(&mut out, n.clone(), c, true);
            }
            if let Some(o) = old {
                put(&mut out, o.to_string(), c, false);
            }
            if old.is_none()
                && let Some(l) = new.as_deref().and_then(lamda)
            {
                put(&mut out, l, c, true);
            }
        }
    }
    put(&mut out, "BELL (BEL)".into(), 7, true);
    out
}

fn lookup<T: Copy>(table: &[(u32, T)], c: u32) -> Option<T> {
    table.binary_search_by_key(&c, |&(code, _)| code).ok().map(|i| table[i].1)
}

/// A character's canonical combining class, 0 for most.
pub fn combining_class(c: u32) -> u8 {
    let i = COMBINING_CLASS.partition_point(|&(_, last, _)| last < c);
    COMBINING_CLASS.get(i).filter(|&&(first, _, _)| first <= c).map_or(0, |&(_, _, v)| v)
}

/// A character's decomposition, as its `decomposition` property: its tag,
/// as `compat` or `fraction`, if not canonical, and the characters, or
/// the character alone where it does not decompose.
pub fn decomposition(c: u32) -> (Option<&'static str>, Vec<u32>) {
    match DECOMPOSITION.binary_search_by_key(&c, |&(code, _, _)| code) {
        Ok(i) => {
            let (_, tag, chars) = DECOMPOSITION[i];
            ((!tag.is_empty()).then_some(tag), chars.to_vec())
        }
        Err(_) => (None, vec![c]),
    }
}

/// A character's general category, as "Lu".
pub fn general_category(c: u32) -> &'static str {
    let table = crate::chartab_data::GENERAL_CATEGORY;
    let i = table.partition_point(|&(_, last, _)| last < c);
    table.get(i).filter(|&&(first, _, _)| first <= c).map_or("Cn", |&(_, _, cat)| crate::chartab_data::CATEGORY_NAMES[cat as usize])
}

fn special(c: u32, which: usize) -> Option<&'static str> {
    let table = crate::chartab_data::SPECIAL_CASING;
    let i = table.binary_search_by_key(&c, |e| e.0).ok()?;
    let (_, up, down, title) = table[i];
    [up, down, title][which]
}

/// A character's value of a property in `char-code-property-alist`, as
/// `get-char-code-property` gives it; `None` for a property it does not
/// list, `Some(Value::Null)` for a character without a value.
pub fn property(c: u32, property: &str) -> Option<Value> {
    let num = |n: u32| Value::Number(n as f64);
    let str = |s: &str| Value::Str(s.to_string());
    let opt_str = |s: Option<&str>| s.map_or(Value::Null, str);
    let ch = char::from_u32(c);
    Some(match property {
        "name" => name(c).map_or(Value::Null, Value::Str),
        "old-name" => opt_str(old_name(c)),
        "general-category" => str(general_category(c)),
        "canonical-combining-class" => num(combining_class(c) as u32),
        // L for what is no Unicode character, as Emacs's table has.
        "bidi-class" => str(ch.map_or("L", |ch| crate::bidi::bidi_class(ch).name())),
        "decomposition" => {
            let (tag, chars) = decomposition(c);
            Value::List(tag.map(str).into_iter().chain(chars.into_iter().map(num)).collect())
        }
        "decimal-digit-value" => lookup(DECIMAL_DIGIT_VALUE, c).map_or(Value::Null, |v| num(v as u32)),
        "digit-value" => lookup(DIGIT_VALUE, c).map_or(Value::Null, |v| num(v as u32)),
        "numeric-value" => lookup(NUMERIC_VALUE, c).map_or(Value::Null, Value::Number),
        "mirrored" => str(if ch.is_some_and(crate::bidi::mirrored) { "Y" } else { "N" }),
        "mirroring" => ch.and_then(crate::bidi::mirror).map_or(Value::Null, |m| num(m as u32)),
        "paired-bracket" => ch.and_then(crate::bidi::paired_bracket).map_or(Value::Null, |(p, _)| num(p as u32)),
        "bracket-type" => str(match ch.and_then(crate::bidi::paired_bracket) {
            Some((_, true)) => "o",
            Some((_, false)) => "c",
            None => "n",
        }),
        "iso-10646-comment" => Value::Null,
        // Nil where the character has no mapping of its own.
        "uppercase" => lookup(UPPERCASE, c).map_or(Value::Null, num),
        "lowercase" => lookup(LOWERCASE, c).map_or(Value::Null, num),
        "titlecase" => lookup(TITLECASE, c).map_or(Value::Null, num),
        "special-uppercase" => opt_str(special(c, 0)),
        "special-lowercase" => opt_str(special(c, 1)),
        "special-titlecase" => opt_str(special(c, 2)),
        _ => return None,
    })
}

/// What a property's value means, as `char-code-property-description`:
/// for general-category, canonical-combining-class, bidi-class and
/// bracket-type, Emacs's words; for a decomposition's tag, the tag.
pub fn description(property: &str, value: &str) -> Option<&'static str> {
    if property == "decomposition" {
        return DECOMPOSITION.iter().map(|&(_, tag, _)| tag).find(|t| !t.is_empty() && *t == value);
    }
    DESCRIPTIONS.iter().find(|&&(p, v, _)| p == property && v == value).map(|&(_, _, d)| d)
}

/// The runs of a property's values over every character, for its
/// char-table: what every character has unless a run says otherwise,
/// and the runs. Names and decompositions are given for the characters
/// that have their own, not those made from their code.
pub fn property_runs(property: &str) -> Option<crate::bidi::PropertyRuns> {
    if let Some(runs) = crate::bidi::property_runs(property) {
        return Some(runs);
    }
    let num = |n: u32| Value::Number(n as f64);
    let str = |s: &str| Value::Str(s.to_string());
    let pairs = |table: &[(u32, u32)]| table.iter().map(|&(c, v)| (c, c, num(v))).collect::<Vec<_>>();
    Some(match property {
        "name" => (Value::Null, named().map(|(c, n)| (c, c, str(n))).collect()),
        "old-name" => (Value::Null, old_named().map(|(c, n)| (c, c, str(n))).collect()),
        "general-category" => (
            str("Cn"),
            crate::chartab_data::GENERAL_CATEGORY.iter().map(|&(f, l, cat)| (f, l, str(crate::chartab_data::CATEGORY_NAMES[cat as usize]))).collect(),
        ),
        "canonical-combining-class" => (num(0), COMBINING_CLASS.iter().map(|&(f, l, v)| (f, l, num(v as u32))).collect()),
        "decomposition" => (
            Value::Null,
            DECOMPOSITION
                .iter()
                .map(|&(c, tag, chars)| (c, c, Value::List((!tag.is_empty()).then(|| str(tag)).into_iter().chain(chars.iter().map(|&x| num(x))).collect())))
                .collect(),
        ),
        "decimal-digit-value" => (Value::Null, DECIMAL_DIGIT_VALUE.iter().map(|&(c, v)| (c, c, num(v as u32))).collect()),
        "digit-value" => (Value::Null, DIGIT_VALUE.iter().map(|&(c, v)| (c, c, num(v as u32))).collect()),
        "numeric-value" => (Value::Null, NUMERIC_VALUE.iter().map(|&(c, v)| (c, c, Value::Number(v))).collect()),
        "iso-10646-comment" => (Value::Null, Vec::new()),
        "uppercase" => (Value::Null, pairs(UPPERCASE)),
        "lowercase" => (Value::Null, pairs(LOWERCASE)),
        "titlecase" => (Value::Null, pairs(TITLECASE)),
        "special-uppercase" | "special-lowercase" | "special-titlecase" => {
            let which = ["special-uppercase", "special-lowercase", "special-titlecase"].iter().position(|p| *p == property).unwrap_or(0);
            (Value::Null, crate::chartab_data::SPECIAL_CASING.iter().filter_map(|e| special(e.0, which).map(|s| (e.0, e.0, str(s)))).collect())
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_emacs_names() {
        assert_eq!(name(0x41).as_deref(), Some("LATIN CAPITAL LETTER A"));
        assert_eq!(name(0x1F600).as_deref(), Some("GRINNING FACE"));
        assert_eq!(name(0xAC00).as_deref(), Some("HANGUL SYLLABLE GA"));
        assert_eq!(name(0xD7A3).as_deref(), Some("HANGUL SYLLABLE HIH"));
        assert_eq!(name(0x4E00).as_deref(), Some("CJK IDEOGRAPH-4E00"));
        assert_eq!(name(7), None);
        assert_eq!(old_name(7), Some("BELL"));
        assert_eq!(from_made_name("CJK IDEOGRAPH-4E00"), Some(0x4E00));
        assert_eq!(from_made_name("HANGUL SYLLABLE GA"), Some(0xAC00));
        assert_eq!(decomposition(0xE9), (None, vec![0x65, 0x301]));
        assert_eq!(decomposition(0xBD), (Some("fraction"), vec![0x31, 0x2044, 0x32]));
        assert_eq!(combining_class(0x300), 230);
    }
}
