//! JSON as Emacs's json.c reads and writes it (ADR 0100): objects keep
//! their keys' order, errors name where they are as json.c's do, and the
//! values that stand for null and false are the caller's. A JSON object
//! crosses to and from scripts as a list starting with OBJECT, then its
//! [key, value] pairs, which the prelude turns into a JavaScript object.

use crate::*;
use crate::natives::natives;

/// What marks a list as a JSON object between the natives and the prelude:
/// a symbol, which no JSON string can be.
const OBJECT: &str = "__e8JsonObject";

enum Json {
    Null,
    False,
    True,
    Number(f64),
    Str(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

/// A parse error: json.c's condition, and the line, column and position,
/// counted from 1, 0 and 0 as json.c counts them, of where it was found.
struct ParseError(&'static str, usize);

struct Parser<'a> {
    chars: &'a [char],
    at: usize,
}

impl Parser<'_> {
    fn skip_space(&mut self) {
        while self.chars.get(self.at).is_some_and(|c| matches!(c, ' ' | '\t' | '\n' | '\r')) {
            self.at += 1;
        }
    }

    fn fail<T>(&self, condition: &'static str) -> Result<T, ParseError> {
        Err(ParseError(condition, self.at))
    }

    fn end_or<T>(&self, condition: &'static str) -> Result<T, ParseError> {
        if self.at >= self.chars.len() { self.fail("json-end-of-file") } else { self.fail(condition) }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, ParseError> {
        for c in word.chars() {
            if self.chars.get(self.at) != Some(&c) {
                return self.end_or("json-parse-error");
            }
            self.at += 1;
        }
        Ok(value)
    }

    fn value(&mut self) -> Result<Json, ParseError> {
        self.skip_space();
        match self.chars.get(self.at) {
            None => self.fail("json-end-of-file"),
            Some('n') => self.literal("null", Json::Null),
            Some('t') => self.literal("true", Json::True),
            Some('f') => self.literal("false", Json::False),
            Some('"') => self.string().map(Json::Str),
            Some('[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.skip_space();
                if self.chars.get(self.at) == Some(&']') {
                    self.at += 1;
                    return Ok(Json::Array(items));
                }
                loop {
                    items.push(self.value()?);
                    self.skip_space();
                    match self.chars.get(self.at) {
                        Some(',') => self.at += 1,
                        Some(']') => {
                            self.at += 1;
                            return Ok(Json::Array(items));
                        }
                        _ => return self.end_or("json-parse-error"),
                    }
                }
            }
            Some('{') => {
                self.at += 1;
                let mut pairs: Vec<(String, Json)> = Vec::new();
                self.skip_space();
                if self.chars.get(self.at) == Some(&'}') {
                    self.at += 1;
                    return Ok(Json::Object(pairs));
                }
                loop {
                    self.skip_space();
                    if self.chars.get(self.at) != Some(&'"') {
                        return self.end_or("json-parse-error");
                    }
                    let key = self.string()?;
                    self.skip_space();
                    if self.chars.get(self.at) != Some(&':') {
                        return self.end_or("json-parse-error");
                    }
                    self.at += 1;
                    let value = self.value()?;
                    // A key given twice keeps its first value, as json.c's objects do.
                    if !pairs.iter().any(|(k, _)| *k == key) {
                        pairs.push((key, value));
                    }
                    self.skip_space();
                    match self.chars.get(self.at) {
                        Some(',') => self.at += 1,
                        Some('}') => {
                            self.at += 1;
                            return Ok(Json::Object(pairs));
                        }
                        _ => return self.end_or("json-parse-error"),
                    }
                }
            }
            Some(c) if *c == '-' || c.is_ascii_digit() => {
                let start = self.at;
                while self.chars.get(self.at).is_some_and(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | 'e' | 'E')) {
                    self.at += 1;
                }
                let text: String = self.chars[start..self.at].iter().collect();
                text.parse::<f64>().map(Json::Number).or_else(|_| {
                    self.at = start;
                    self.fail("json-parse-error")
                })
            }
            Some(_) => self.fail("json-parse-error"),
        }
    }

    /// Four hex digits of a `\\u` escape.
    fn hex4(&mut self) -> Result<u32, ParseError> {
        let hex: String = self.chars.get(self.at..self.at + 4).ok_or(ParseError("json-end-of-file", self.chars.len()))?.iter().collect();
        let n = u32::from_str_radix(&hex, 16).map_err(|_| ParseError("json-parse-error", self.at))?;
        self.at += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let Some(&c) = self.chars.get(self.at) else { return self.fail("json-end-of-file") };
            self.at += 1;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let Some(&e) = self.chars.get(self.at) else { return self.fail("json-end-of-file") };
                    self.at += 1;
                    out.push(match e {
                        '"' => '"',
                        '\\' => '\\',
                        '/' => '/',
                        'b' => '\u{8}',
                        'f' => '\u{c}',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        'u' => {
                            let first = self.hex4()?;
                            if (0xD800..0xDC00).contains(&first) && self.chars.get(self.at) == Some(&'\\') && self.chars.get(self.at + 1) == Some(&'u') {
                                self.at += 2;
                                let second = self.hex4()?;
                                char::from_u32(0x10000 + ((first - 0xD800) << 10) + (second.wrapping_sub(0xDC00) & 0x3FF)).unwrap_or('\u{FFFD}')
                            } else {
                                char::from_u32(first).unwrap_or('\u{FFFD}')
                            }
                        }
                        _ => return self.fail("json-escape-sequence-error"),
                    });
                }
                c if (c as u32) < 0x20 => return self.fail("json-parse-error"),
                c => out.push(c),
            }
        }
    }
}

/// The options parsing takes: how objects and arrays come back, and what stands for null and false.
struct Shape {
    object: String,
    list: bool,
    null: EditorValue,
    false_: EditorValue,
}

fn to_value(j: Json, shape: &Shape) -> EditorValue {
    match j {
        Json::Null => shape.null.clone(),
        Json::False => shape.false_.clone(),
        Json::True => EditorValue::Bool(true),
        Json::Number(n) => EditorValue::Number(n),
        Json::Str(s) => EditorValue::Str(s),
        Json::Array(items) => EditorValue::List(items.into_iter().map(|i| to_value(i, shape)).collect()),
        Json::Object(pairs) => match shape.object.as_str() {
            "alist" => EditorValue::List(pairs.into_iter().map(|(k, v)| EditorValue::List(vec![EditorValue::Str(k), to_value(v, shape)])).collect()),
            "plist" => EditorValue::List(pairs.into_iter().flat_map(|(k, v)| [EditorValue::Str(format!(":{k}")), to_value(v, shape)]).collect()),
            _ => EditorValue::List(
                std::iter::once(EditorValue::Symbol(OBJECT.into()))
                    .chain(pairs.into_iter().map(|(k, v)| EditorValue::List(vec![EditorValue::Str(k), to_value(v, shape)])))
                    .collect(),
            ),
        },
    }
}

/// Parses JSON at the start of `text`, giving the value and where it ends.
fn parse_prefix(text: &[char]) -> Result<(Json, usize), ParseError> {
    let mut p = Parser { chars: text, at: 0 };
    let value = p.value()?;
    Ok((value, p.at))
}

/// json.c's error for a parse error, with the line, column and position.
fn parse_error(text: &[char], e: ParseError, base: usize) -> Error {
    let ParseError(condition, at) = e;
    // json.c has read the character it stops at, so it counts past it; at the end there is none.
    let at = if condition == "json-end-of-file" { at } else { (at + 1).min(text.len()) };
    let line = text[..at.min(text.len())].iter().filter(|&&c| c == '\n').count() + 1;
    let column = at - text[..at.min(text.len())].iter().rposition(|&c| c == '\n').map_or(0, |i| i + 1);
    // The conditions' messages, as json.c defines them.
    let message = match condition {
        "json-end-of-file" => "end of JSON stream",
        "json-trailing-content" => "trailing content after JSON stream",
        "json-escape-sequence-error" => "invalid escape sequence",
        _ => "could not parse JSON stream",
    };
    let n = |x: usize| EditorValue::Number(x as f64);
    Error::signal(condition, message, vec![n(line), n(column), n(base + at)])
}

fn shape(object_type: String, array_type: String, null: EditorValue, false_: EditorValue) -> Result<Shape> {
    if !matches!(object_type.as_str(), "hash-table" | "alist" | "plist") {
        return Err(Error::signal("error", format!("Invalid :object-type {object_type}"), Vec::new()));
    }
    Ok(Shape { object: object_type, list: array_type == "list", null, false_ })
}

/// Writes a value as JSON, as json.c's json_out_something does.
fn write(value: &EditorValue, null: &EditorValue, false_: &EditorValue, out: &mut String, depth: usize) -> Result<()> {
    if depth > 1000 {
        return Err(Error::signal("json-object-too-deep", "object cyclic or Lisp evaluation too deep", Vec::new()));
    }
    if value == null {
        out.push_str("null");
        return Ok(());
    }
    if value == false_ {
        out.push_str("false");
        return Ok(());
    }
    match value {
        EditorValue::Bool(true) => out.push_str("true"),
        // Lisp's nil is an empty object, as an empty alist or plist.
        EditorValue::Null | EditorValue::Bool(false) => out.push_str("{}"),
        EditorValue::Number(n) if n.is_finite() => {
            if n.fract() == 0.0 && n.abs() < 1e17 {
                out.push_str(&format!("{}", *n as i64));
            } else {
                out.push_str(&format!("{n}"));
            }
        }
        EditorValue::Str(_) | EditorValue::Text(_) => {
            let s = value.as_str().unwrap_or("");
            if s.chars().any(|c| e8_core::coding::char_raw_byte(c).is_some()) {
                return Err(e8_core::xfaces::wrong_type("json-value-p", value));
            }
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    '\u{8}' => out.push_str("\\b"),
                    '\u{c}' => out.push_str("\\f"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        EditorValue::List(items) if matches!(items.first(), Some(EditorValue::Symbol(s)) if s == OBJECT) => {
            out.push('{');
            let mut seen: Vec<&str> = Vec::new();
            for pair in &items[1..] {
                let EditorValue::List(kv) = pair else { return Err(e8_core::xfaces::wrong_type("consp", pair)) };
                let Some(key) = kv.first().and_then(EditorValue::as_str) else { return Err(e8_core::xfaces::wrong_type("stringp", pair)) };
                // A key given twice is written once, its first value, as json.c does.
                if seen.contains(&key) {
                    continue;
                }
                if !seen.is_empty() {
                    out.push(',');
                }
                seen.push(key);
                write(&EditorValue::Str(key.to_string()), &EditorValue::Null, &EditorValue::Null, out, depth + 1)?;
                out.push(':');
                write(kv.get(1).unwrap_or(&EditorValue::Null), null, false_, out, depth + 1)?;
            }
            out.push('}');
        }
        EditorValue::List(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, null, false_, out, depth + 1)?;
            }
            out.push(']');
        }
        other => return Err(e8_core::xfaces::wrong_type("json-value-p", other)),
    }
    Ok(())
}

natives! {
    /// Parse a string of JSON, as json-parse-string, objects as the prelude turns them out.
    fn jsonParse(_ed, text: String, object_type: String, array_type: String, null: EditorValue, false_value: EditorValue) -> EditorValue {
        let shape = shape(object_type, array_type, null, false_value)?;
        let chars: Vec<char> = text.chars().collect();
        let (value, end) = parse_prefix(&chars).map_err(|e| parse_error(&chars, e, 0))?;
        let mut rest = Parser { chars: &chars, at: end };
        rest.skip_space();
        if rest.at < chars.len() {
            return Err(parse_error(&chars, ParseError("json-trailing-content", rest.at), 0));
        }
        let _ = shape.list;
        Ok(to_value(value, &shape))
    }

    /// Parse the JSON after point and move point past it, as json-parse-buffer.
    fn jsonParseBufferNative(ed, object_type: String, array_type: String, null: EditorValue, false_value: EditorValue) -> EditorValue {
        let shape = shape(object_type, array_type, null, false_value)?;
        let (point, end) = (ed.buffer().point(), ed.buffer().point_max());
        let chars: Vec<char> = ed.buffer().slice(point..end).chars().collect();
        let (value, at) = parse_prefix(&chars).map_err(|e| parse_error(&chars, e, point))?;
        ed.buffer_mut().set_point(point + at);
        Ok(to_value(value, &shape))
    }

    /// Write a value as JSON, as json-serialize, objects as the prelude turns them in.
    fn jsonWrite(_ed, value: EditorValue, null: EditorValue, false_value: EditorValue) -> String {
        let mut out = String::new();
        write(&value, &null, &false_value, &mut out, 0)?;
        Ok(out)
    }
}
