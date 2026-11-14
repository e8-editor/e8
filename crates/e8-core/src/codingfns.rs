//! The coding and charset primitives Lisp calls, as coding.c, charset.c
//! and the parts of mule.el and mule-cmds.el around them: encoding and
//! decoding strings and regions, finding a coding from bytes, asking about
//! coding systems by name, and which codings can write some text.
//!
//! Scripts hold bytes as strings of characters U+0000 to U+00FF, one for
//! each byte, as Emacs's unibyte strings print. A string with other
//! characters stands for the bytes Emacs keeps it in, UTF-8, as Emacs's
//! multibyte strings do when decoded.

use crate::charset;
use crate::coding::{self, Coding, Eol, bytes_of_string, raw_byte_char, string_of_bytes};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// Emacs's error for a name that is no coding system.
pub fn coding_system_error(name: &str) -> Error {
    Error::signal("coding-system-error", format!("Invalid coding system: {name}"), vec![Value::Str(name.to_string())])
}

/// The coding system a name names, or Emacs's error, as `check-coding-system`.
pub fn check_coding_system(name: &str) -> Result<Coding> {
    Coding::parse(name).ok_or_else(|| coding_system_error(name))
}

/// The bytes a string stands for: its characters as bytes, or the UTF-8
/// Emacs keeps multibyte text in.
fn string_bytes(s: &str) -> Vec<u8> {
    bytes_of_string(s).unwrap_or_else(|| Coding::named("raw-text").encode_lossy(s).0)
}

/// Text in a buffer as the bytes Emacs keeps it in: raw bytes as themselves,
/// anything else as UTF-8.
fn text_bytes(s: &str) -> Vec<u8> {
    Coding::named("raw-text").encode_lossy(s).0
}

/// The base coding systems that can write all of `text`, as
/// `find-coding-systems-string`: `undecided` alone for ASCII.
pub fn find_coding_systems(text: &str) -> Vec<String> {
    if text.is_ascii() {
        return vec!["undecided".into()];
    }
    let mut found: Vec<String> = Coding::base_systems()
        .filter(|c| !matches!(c.system().name, "undecided" | "prefer-utf-8"))
        .filter(|c| text.chars().all(|ch| c.can_encode(ch)))
        .map(|c| c.system().name.to_string())
        .collect();
    // Emacs's preferred coding first.
    if let Some(i) = found.iter().position(|n| n == "utf-8") {
        let utf8 = found.remove(i);
        found.insert(0, utf8);
    }
    found
}

/// Where in `text`, counted from `start`, the characters `coding` cannot
/// write are, at most `count` of them.
fn unencodable(text: &str, start: usize, coding: Coding, count: usize) -> Vec<usize> {
    text.chars().enumerate().filter(|(_, c)| !coding.can_encode(*c)).take(count).map(|(i, _)| start + i).collect()
}

fn num(n: usize) -> Value {
    Value::Number(n as f64)
}

fn strings(names: impl IntoIterator<Item = String>) -> Value {
    Value::List(names.into_iter().map(Value::Str).collect())
}

/// An argument as text: a string, or a symbol's name.
fn text_arg(args: &[Value], i: usize) -> Result<String> {
    match args.get(i) {
        Some(v) => v.as_str().map(str::to_string).ok_or_else(|| Error::new(format!("Wrong type argument: stringp, {v:?}"))),
        None => Err(Error::new("Wrong number of arguments")),
    }
}

fn number_arg(args: &[Value], i: usize) -> Result<usize> {
    args.get(i).and_then(Value::as_number).map(|n| n.max(0.0) as usize).ok_or_else(|| Error::new("Wrong type argument: integer-or-marker-p"))
}

impl Editor {
    /// The text between two positions, in either order, or Emacs's error
    /// for a region that is not within the buffer.
    fn region_text(&self, start: usize, end: usize) -> Result<String> {
        let (from, to) = (start.min(end), start.max(end));
        if to > self.buffer().len() {
            let data = vec![Value::Number(start as f64), Value::Number(end as f64)];
            return Err(Error::signal("args-out-of-range", format!("Args out of range: {start}, {end}"), data));
        }
        Ok(self.buffer().slice(from..to))
    }
}

/// Emacs's error for a name that is no charset.
fn invalid_charset(name: &str) -> Error {
    Error::signal("error", format!("Invalid charset: {name}"), vec![Value::Str(name.to_string())])
}

/// An argument as one character, as the primitives that take a character do.
fn char_arg(args: &[Value], i: usize) -> Result<char> {
    match args.get(i) {
        Some(Value::Number(n)) => char::from_u32(*n as u32).ok_or_else(|| Error::new("Wrong type argument: characterp")),
        Some(v) => v.as_str().and_then(|s| s.chars().next()).ok_or_else(|| Error::new("Wrong type argument: characterp")),
        None => Err(Error::new("Wrong number of arguments")),
    }
}

/// A charset name as an argument, or Emacs's error for one that is no charset.
fn charset_arg(args: &[Value], i: usize) -> Result<&'static str> {
    let name = text_arg(args, i)?;
    charset::canonical_name(&name).ok_or_else(|| invalid_charset(&name))
}

fn given(args: &[Value], i: usize) -> bool {
    args.get(i).is_some_and(Value::is_true)
}

impl Editor {
    /// Runs one of the coding and charset primitives by its Lisp name, as
    /// scripts call them.
    pub fn coding_primitive(&mut self, name: &str, args: &[Value]) -> Result<Value> {
        let coding = |i: usize| -> Result<Coding> { check_coding_system(&text_arg(args, i)?) };
        Ok(match name {
            "coding-system-p" => Value::Bool(args.first().and_then(Value::as_str).is_some_and(|n| Coding::parse(n).is_some())),
            "check-coding-system" => Value::Str(coding(0)?.name()),
            "coding-system-list" => {
                let base_only = given(args, 0);
                let mut names = Vec::new();
                for c in Coding::base_systems() {
                    names.push(c.name());
                    if !base_only && c.with_eol(Some(Eol::Unix)) != c {
                        names.extend([Eol::Unix, Eol::Dos, Eol::Mac].map(|e| c.with_eol(Some(e)).name()));
                    }
                }
                strings(names)
            }
            "coding-system-aliases" => {
                let c = coding(0)?;
                // Each with the line ends asked about, as `utf-8-unix`'s are `mule-utf-8-unix` and on.
                let suffix = c.name()[c.system().name.len()..].to_string();
                strings(std::iter::once(c.system().name).chain(c.system().aliases.iter().copied()).map(|n| format!("{n}{suffix}")))
            }
            "coding-system-base" => Value::Str(coding(0)?.system().name.to_string()),
            "set-coding-system-priority" => {
                let codings = (0..args.len()).map(coding).collect::<Result<Vec<_>>>()?;
                crate::coding::set_priority(&codings);
                Value::Null
            }
            "coding-system-priority-list" => {
                let list = crate::coding::priority_list();
                let names = list.iter().map(|c| c.system().name.to_string());
                if given(args, 0) { strings(names.take(1)) } else { strings(names) }
            }
            "coding-system-type" => Value::Str(coding(0)?.system().coding_type.to_string()),
            "coding-system-eol-type" => {
                let c = coding(0)?;
                match c.eol {
                    Some(eol) => num(eol.number() as usize),
                    None => strings([Eol::Unix, Eol::Dos, Eol::Mac].map(|e| c.with_eol(Some(e)).name())),
                }
            }
            "coding-system-change-eol-conversion" => {
                let c = coding(0)?;
                let eol = match args.get(1) {
                    Some(Value::Number(n)) => Eol::from_number(*n as u8),
                    Some(v) => match v.as_str() {
                        Some("unix") => Some(Eol::Unix),
                        Some("dos") => Some(Eol::Dos),
                        Some("mac") => Some(Eol::Mac),
                        _ => None,
                    },
                    None => None,
                };
                Value::Str(c.with_eol(eol).name())
            }
            "coding-system-change-text-conversion" => Value::Str(coding(0)?.with_text(coding(1)?).name()),
            "coding-system-get" => {
                let c = coding(0)?;
                let prop = text_arg(args, 1)?;
                match prop.trim_start_matches(':') {
                    "mime-charset" => c.system().mime_charset.map_or(Value::Null, |m| Value::Str(m.to_string())),
                    "mnemonic" => Value::Str(c.system().mnemonic.to_string()),
                    "name" => Value::Str(c.system().name.to_string()),
                    "coding-type" => Value::Str(c.system().coding_type.to_string()),
                    _ => Value::Null,
                }
            }
            "encode-coding-string" => {
                let (bytes, used) = coding(1)?.encode_lossy(&text_arg(args, 0)?);
                self.set_variable("last-coding-system-used", Value::Str(used.name()));
                Value::Str(string_of_bytes(&bytes))
            }
            "decode-coding-string" => {
                let (text, used) = coding(1)?.decode(&string_bytes(&text_arg(args, 0)?));
                self.set_variable("last-coding-system-used", Value::Str(used.name()));
                Value::Str(text)
            }
            "encode-coding-region" | "decode-coding-region" => {
                let c = coding(2)?;
                let (start, end) = (number_arg(args, 0)?, number_arg(args, 1)?);
                let text = self.region_text(start, end)?;
                let (start, end) = (start.min(end), start.max(end));
                let (new, used) = if name == "encode-coding-region" {
                    let (bytes, used) = c.encode_lossy(&text);
                    (bytes.into_iter().map(raw_byte_char).collect::<String>(), used)
                } else {
                    c.decode(&text_bytes(&text))
                };
                self.replace_range(start, end, &new)?;
                self.set_variable("last-coding-system-used", Value::Str(used.name()));
                num(new.chars().count())
            }
            "detect-coding-string" | "detect-coding-region" => {
                let (bytes, highest) = if name == "detect-coding-string" {
                    (string_bytes(&text_arg(args, 0)?), given(args, 1))
                } else {
                    let (start, end) = (number_arg(args, 0)?, number_arg(args, 1)?);
                    (text_bytes(&self.region_text(start, end)?), given(args, 2))
                };
                let found = coding::detect(&bytes);
                // With the line ends found too, as Emacs gives them.
                let eol = found[0].decode(&bytes).1.eol;
                let found: Vec<String> = found.iter().map(|c| if c.eol.is_none() && eol != Some(Eol::Unix) { c.with_eol(eol).name() } else { c.name() }).collect();
                if highest { Value::Str(found[0].clone()) } else { strings(found) }
            }
            "find-coding-systems-string" => strings(find_coding_systems(&text_arg(args, 0)?)),
            "find-coding-systems-region" => {
                let text = self.region_text(number_arg(args, 0)?, number_arg(args, 1)?)?;
                strings(find_coding_systems(&text))
            }
            "unencodable-char-position" => {
                let (start, end, c) = (number_arg(args, 0)?, number_arg(args, 1)?, coding(2)?);
                let count = args.get(3).and_then(Value::as_number).map(|n| n as usize);
                let text = match args.get(4).and_then(Value::as_str) {
                    Some(s) => s.chars().skip(start).take(end.saturating_sub(start)).collect(),
                    None => self.region_text(start, end)?,
                };
                let found = unencodable(&text, start, c, count.unwrap_or(1));
                match count {
                    Some(_) if !found.is_empty() => Value::List(found.into_iter().map(num).collect()),
                    _ => found.first().map_or(Value::Null, |&p| num(p)),
                }
            }
            "check-coding-systems-region" => {
                let (start, end) = (number_arg(args, 0)?, number_arg(args, 1)?);
                let text = self.region_text(start, end)?;
                let names: Vec<String> = match args.get(2) {
                    Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                    _ => Vec::new(),
                };
                let mut failing = Vec::new();
                for n in names {
                    let found = unencodable(&text, start.min(end), check_coding_system(&n)?, usize::MAX);
                    if !found.is_empty() {
                        failing.push(Value::List(std::iter::once(Value::Str(n)).chain(found.into_iter().map(num)).collect()));
                    }
                }
                if failing.is_empty() { Value::Null } else { Value::List(failing) }
            }
            "charsetp" => Value::Bool(args.first().and_then(Value::as_str).is_some_and(charset::charsetp)),
            "charset-list" => strings(self.charsets.charset_list().into_iter().map(String::from)),
            "charset-priority-list" => {
                let all = self.charsets.charset_list();
                strings(if given(args, 0) { all[..1].to_vec() } else { all }.into_iter().map(String::from))
            }
            "char-charset" => {
                let c = text_arg(args, 0)?.chars().next().ok_or_else(|| Error::new("Wrong type argument: characterp"))?;
                let restriction: Option<Vec<String>> = match args.get(1) {
                    Some(Value::List(items)) => Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
                    _ => None,
                };
                self.charsets.char_charset(c, restriction.as_deref()).map_or(Value::Null, |n| Value::Str(n.to_string()))
            }
            "encode-char" => {
                let c = text_arg(args, 0)?.chars().next().ok_or_else(|| Error::new("Wrong type argument: characterp"))?;
                let set = text_arg(args, 1)?;
                if !charset::charsetp(&set) {
                    return Err(Error::signal("error", format!("Invalid charset: {set}"), vec![]));
                }
                charset::encode_char(c, &set).map_or(Value::Null, |n| num(n as usize))
            }
            "decode-char" => {
                let set = text_arg(args, 0)?;
                if !charset::charsetp(&set) {
                    return Err(Error::signal("error", format!("Invalid charset: {set}"), vec![]));
                }
                charset::decode_char(&set, number_arg(args, 1)? as u32).map_or(Value::Null, |c| Value::Str(c.to_string()))
            }
            "charset-id-internal" => charset::charset_id(&text_arg(args, 0)?).map_or(Value::Null, num),
            "set-charset-priority" => {
                let names: Vec<&'static str> = (0..args.len()).map(|i| charset_arg(args, i)).collect::<Result<_>>()?;
                self.charsets.set_priority(&names);
                Value::Null
            }
            "sort-charsets" => {
                let items = match args.first() {
                    Some(Value::List(items)) => items.clone(),
                    _ => return Err(Error::signal("wrong-type-argument", "Wrong type argument: listp", Vec::new())),
                };
                let mut names = Vec::new();
                for item in &items {
                    let name = item.as_str().unwrap_or_default();
                    if !charset::charsetp(name) {
                        let message = format!("Wrong type argument: charsetp, {name}");
                        return Err(Error::signal("wrong-type-argument", message, vec![item.clone()]));
                    }
                    names.push(name.to_string());
                }
                strings(self.charsets.sort_charsets(&names))
            }
            "charset-plist" => match self.charsets.charset_plist(&text_arg(args, 0)?) {
                Some(plist) => Value::List(plist.into_iter().flat_map(|(k, v)| [Value::Str(k), v]).collect()),
                None => return Err(invalid_charset(&text_arg(args, 0)?)),
            },
            "set-charset-plist" => {
                let name = charset_arg(args, 0)?;
                let items = match args.get(1) {
                    Some(Value::List(items)) => items.clone(),
                    Some(Value::Null) | None => Vec::new(),
                    Some(_) => return Err(Error::signal("wrong-type-argument", "Wrong type argument: listp", Vec::new())),
                };
                let mut props = Vec::new();
                for pair in items.chunks(2) {
                    if let [key, value] = pair {
                        let key = key.as_str().map(str::to_string).unwrap_or_default();
                        props.push((key, value.clone()));
                    }
                }
                self.charsets.set_charset_plist(name, props);
                Value::Null
            }
            "make-char" => {
                let set = charset_arg(args, 0)?.to_string();
                // The codes given, up to the first one left out.
                let codes: Vec<u32> = args[1..].iter().take_while(|v| v.is_true()).map(|v| v.as_number().unwrap_or(-1.0) as i64 as u32).collect();
                match charset::make_char(&set, &codes) {
                    Some(c) => Value::Str(c.to_string()),
                    None => return Err(Error::signal("args-out-of-range", format!("Args out of range: {set}"), vec![Value::Str(set)])),
                }
            }
            "split-char" => {
                let c = char_arg(args, 0)?;
                match self.charsets.split_char(c) {
                    Some((set, codes)) => Value::List(std::iter::once(Value::Str(set.to_string())).chain(codes.into_iter().map(|n| num(n as usize))).collect()),
                    None => Value::Null,
                }
            }
            "find-charset-string" => strings(self.charsets.find_charsets(&text_arg(args, 0)?).into_iter().map(String::from)),
            "find-charset-region" => {
                let text = self.region_text(number_arg(args, 0)?, number_arg(args, 1)?)?;
                strings(self.charsets.find_charsets(&text).into_iter().map(String::from))
            }
            "charset-after" => {
                let pos = match args.first() {
                    Some(v) if v.is_true() => number_arg(args, 0)?,
                    _ => self.buffer().point(),
                };
                let b = self.buffer();
                match (pos < b.len()).then(|| b.slice(pos..pos + 1)).and_then(|s| s.chars().next()) {
                    Some(c) => self.charsets.char_charset(c, None).map_or(Value::Null, |n| Value::Str(n.to_string())),
                    None => Value::Null,
                }
            }
            "decode-sjis-char" | "decode-big5-char" => {
                let coding = if name == "decode-big5-char" { "chinese-big5" } else { "japanese-shift-jis" };
                let code = number_arg(args, 0)? as u32;
                // The code is the coding's own bytes: one for ASCII and for
                // Shift JIS's half-width katakana, two otherwise.
                let bytes: Vec<u8> = if code <= 0xFF { vec![code as u8] } else { vec![(code >> 8) as u8, code as u8] };
                let (text, _) = Coding::named(coding).with_eol(Some(Eol::Unix)).decode(&bytes);
                match text.chars().next().filter(|_| text.chars().count() == 1) {
                    Some(c) if coding::char_raw_byte(c).is_none() => Value::Str(c.to_string()),
                    _ => return Err(Error::signal("error", format!("Invalid code: {code}"), vec![])),
                }
            }
            "encode-sjis-char" | "encode-big5-char" => {
                let coding = if name == "encode-big5-char" { "chinese-big5" } else { "japanese-shift-jis" };
                let c = char_arg(args, 0)?;
                let coding = Coding::named(coding);
                match coding.can_encode(c).then(|| coding.encode_lossy(&c.to_string()).0) {
                    Some(bytes) if bytes.len() == 1 => num(bytes[0] as usize),
                    Some(bytes) if bytes.len() == 2 => num(((bytes[0] as usize) << 8) | bytes[1] as usize),
                    _ => return Err(Error::signal("error", format!("Can't encode character: {c}"), vec![])),
                }
            }
            "multibyte-char-to-unibyte" => {
                // The byte Emacs would keep it as: ASCII, a raw byte, or
                // what iso-8859-1 writes it as; -1 for anything else.
                let c = char_arg(args, 0)?;
                match coding::char_raw_byte(c) {
                    Some(b) => num(b as usize),
                    None if (c as u32) < 0x100 => num(c as usize),
                    None => Value::Number(-1.0),
                }
            }
            "unibyte-char-to-multibyte" => {
                let b = number_arg(args, 0)? as u32;
                match b {
                    0..=0x7F => Value::Str(char::from_u32(b).unwrap_or('?').to_string()),
                    0x80..=0xFF => Value::Str(raw_byte_char(b as u8).to_string()),
                    _ => return Err(Error::new("Wrong type argument: characterp")),
                }
            }
            "clear-charset-maps" | "unify-charset" => Value::Null,
            _ => return Err(Error::new(format!("No coding primitive {name}"))),
        })
    }
}
