//! Reading and printing Lisp data, as Emacs's lread.c and print.c do, for
//! the values a file's local variables give and the commands that write
//! them. Data only: nil, t, numbers, characters, strings, symbols, lists,
//! vectors and quoted forms. A list is a [`Value::List`], whose dotted end,
//! `(a . b)`, joins the list as its last element, as E8 writes alists; ()
//! is nil.

use crate::error::{Error, Result};
use crate::variables::Value;

/// Reads one Lisp datum from `text` starting at character `start`, and
/// returns it with the character position after it, as read-from-string.
pub fn read_from_string(text: &str, start: usize) -> Result<(Value, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let mut reader = Reader { chars: &chars, pos: start.min(chars.len()) };
    let value = reader.read()?;
    Ok((value, reader.pos))
}

struct Reader<'a> {
    chars: &'a [char],
    pos: usize,
}

fn eof() -> Error {
    Error::signal("end-of-file", "End of file during parsing", Vec::new())
}

fn invalid(what: &str) -> Error {
    Error::signal("invalid-read-syntax", format!("Invalid read syntax: {what}"), vec![Value::Str(what.to_string())])
}

/// Characters that end a symbol or number.
fn delimits(c: char) -> bool {
    c.is_whitespace() || matches!(c, '(' | ')' | '[' | ']' | '"' | '\'' | ';' | '`' | ',')
}

impl Reader<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn next(&mut self) -> Result<char> {
        let c = self.peek().ok_or_else(eof)?;
        self.pos += 1;
        Ok(c)
    }

    /// Skips whitespace and comments.
    fn skip(&mut self) {
        while let Some(c) = self.peek() {
            if c == ';' {
                while self.peek().is_some_and(|c| c != '\n') {
                    self.pos += 1;
                }
            } else if c.is_whitespace() {
                self.pos += 1;
            } else {
                return;
            }
        }
    }

    fn read(&mut self) -> Result<Value> {
        self.skip();
        let c = self.next()?;
        match c {
            '(' => self.read_list(')'),
            '[' => Ok(match self.read_list(']')? {
                Value::Null => Value::List(Vec::new()),
                v => v,
            }),
            ')' | ']' => Err(invalid(&c.to_string())),
            '"' => self.read_string().map(Value::Str),
            '?' => self.read_char().map(|c| Value::Number(c as u32 as f64)),
            '\'' => Ok(Value::List(vec![Value::Symbol("quote".into()), self.read()?])),
            '`' => Ok(Value::List(vec![Value::Symbol("`".into()), self.read()?])),
            ',' => {
                let name = if self.peek() == Some('@') {
                    self.pos += 1;
                    ",@"
                } else {
                    ","
                };
                Ok(Value::List(vec![Value::Symbol(name.into()), self.read()?]))
            }
            '#' => match self.next()? {
                '\'' => Ok(Value::List(vec![Value::Symbol("function".into()), self.read()?])),
                c => Err(invalid(&format!("#{c}"))),
            },
            _ => {
                self.pos -= 1;
                self.read_atom()
            }
        }
    }

    fn read_list(&mut self, close: char) -> Result<Value> {
        let mut items = Vec::new();
        loop {
            self.skip();
            match self.peek() {
                None => return Err(eof()),
                Some(c) if c == close => {
                    self.pos += 1;
                    return Ok(if items.is_empty() { Value::Null } else { Value::List(items) });
                }
                Some(')' | ']') => return Err(invalid(&self.peek().unwrap_or(')').to_string())),
                Some('.') if close == ')' && self.chars.get(self.pos + 1).is_none_or(|&c| delimits(c)) => {
                    // A dotted end, (a . b): b joins the list, which is how E8 writes an alist's pairs.
                    self.pos += 1;
                    if items.is_empty() {
                        return Err(invalid("."));
                    }
                    match self.read()? {
                        Value::List(rest) => items.extend(rest),
                        Value::Null => {}
                        v => items.push(v),
                    }
                    self.skip();
                    if self.next()? != ')' {
                        return Err(invalid(". in wrong context"));
                    }
                    return Ok(Value::List(items));
                }
                Some(_) => items.push(self.read()?),
            }
        }
    }

    fn read_string(&mut self) -> Result<String> {
        let mut out = String::new();
        loop {
            match self.next()? {
                '"' => return Ok(out),
                '\\' => match self.peek().ok_or_else(eof)? {
                    // An escaped newline or space is nothing, as in Emacs.
                    '\n' | ' ' => self.pos += 1,
                    _ => out.push(self.escape()?),
                },
                c => out.push(c),
            }
        }
    }

    /// The character after `?`.
    fn read_char(&mut self) -> Result<char> {
        let c = self.next()?;
        if c == '\\' { self.escape() } else { Ok(c) }
    }

    /// The character an escape after a backslash stands for.
    fn escape(&mut self) -> Result<char> {
        let c = self.next()?;
        let code = |n: u32| char::from_u32(n).ok_or_else(|| invalid("character code"));
        Ok(match c {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            'f' => '\x0c',
            'a' => '\x07',
            'b' => '\x08',
            'v' => '\x0b',
            'e' => '\x1b',
            'd' => '\x7f',
            's' if self.peek() != Some('-') => ' ',
            'x' => {
                let start = self.pos;
                while self.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                    self.pos += 1;
                }
                let digits: String = self.chars[start..self.pos].iter().collect();
                code(u32::from_str_radix(&digits, 16).map_err(|_| invalid("\\x"))?)?
            }
            'u' | 'U' => {
                let n = if c == 'u' { 4 } else { 8 };
                let digits: String = (0..n).map(|_| self.next()).collect::<Result<_>>()?;
                code(u32::from_str_radix(&digits, 16).map_err(|_| invalid("\\u"))?)?
            }
            '0'..='7' => {
                let mut n = c.to_digit(8).unwrap_or(0);
                for _ in 0..2 {
                    match self.peek().and_then(|c| c.to_digit(8)) {
                        Some(d) => {
                            n = n * 8 + d;
                            self.pos += 1;
                        }
                        None => break,
                    }
                }
                code(n)?
            }
            '^' => {
                let c = self.read_char()?;
                control(c)
            }
            'C' if self.peek() == Some('-') => {
                self.pos += 1;
                let c = self.read_char()?;
                control(c)
            }
            c => c,
        })
    }

    fn read_atom(&mut self) -> Result<Value> {
        let mut name = String::new();
        let mut escaped = false;
        while let Some(c) = self.peek() {
            if delimits(c) {
                break;
            }
            self.pos += 1;
            if c == '\\' {
                name.push(self.next()?);
                escaped = true;
            } else {
                name.push(c);
            }
        }
        if name.is_empty() {
            return Err(invalid("?"));
        }
        if !escaped {
            if let Some(n) = number(&name) {
                return Ok(Value::Number(n));
            }
            match name.as_str() {
                "nil" => return Ok(Value::Null),
                "t" => return Ok(Value::Bool(true)),
                _ => {}
            }
        }
        Ok(Value::Symbol(name))
    }
}

/// The control character of `c`, as ?\C-c and ?\^c read.
fn control(c: char) -> char {
    match c {
        '?' => '\x7f',
        c if c.is_ascii_alphabetic() || ('@'..='_').contains(&c) => char::from_u32(c.to_ascii_uppercase() as u32 & 0x1f).unwrap_or(c),
        c => c,
    }
}

/// A number as Lisp reads one: an integer, with an optional sign and
/// trailing dot, or a float with a point or exponent.
fn number(name: &str) -> Option<f64> {
    let body = name.strip_prefix(['+', '-']).unwrap_or(name);
    if body.is_empty() || !body.starts_with(|c: char| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let int = name.strip_suffix('.').unwrap_or(name);
    if !int.is_empty() && int.trim_start_matches(['+', '-']).chars().all(|c| c.is_ascii_digit()) && !int.trim_start_matches(['+', '-']).is_empty() {
        return int.parse::<f64>().ok();
    }
    let float = body.contains('.') || body.contains(['e', 'E']);
    if float && body.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) && body.chars().any(|c| c.is_ascii_digit()) {
        return name.parse::<f64>().ok();
    }
    None
}

/// The printed form of a value, as prin1-to-string writes it; with
/// `noescape`, strings as their text, as princ.
pub fn prin1_to_string(value: &Value, noescape: bool) -> String {
    let mut out = String::new();
    print(value, noescape, &mut out);
    out
}

fn print(value: &Value, noescape: bool, out: &mut String) {
    match value {
        Value::Null | Value::Bool(false) => out.push_str("nil"),
        Value::Bool(true) => out.push('t'),
        Value::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e16 {
                out.push_str(&format!("{}", *n as i64));
            } else if n.is_nan() {
                out.push_str("0.0e+NaN");
            } else if n.is_infinite() {
                out.push_str(if *n > 0.0 { "1.0e+INF" } else { "-1.0e+INF" });
            } else {
                out.push_str(&format!("{n}"));
            }
        }
        Value::Str(s) => {
            if noescape {
                out.push_str(s);
            } else {
                out.push('"');
                for c in s.chars() {
                    if c == '"' || c == '\\' {
                        out.push('\\');
                    }
                    out.push(c);
                }
                out.push('"');
            }
        }
        Value::Text(t) => print(&Value::Str(t.string.clone()), noescape, out),
        Value::Symbol(name) => {
            if noescape {
                out.push_str(name);
            } else {
                // Characters that would end it, or make it read as something else, are escaped.
                let numeric = number(name).is_some() || name.is_empty();
                for (i, c) in name.chars().enumerate() {
                    if delimits(c) || matches!(c, '\\' | '#' | '?' | '.') && (i == 0 || c == '\\') || (i == 0 && numeric) {
                        out.push('\\');
                    }
                    out.push(c);
                }
            }
        }
        Value::List(items) => {
            if let [Value::Symbol(q), x] = items.as_slice() {
                let prefix = match q.as_str() {
                    "quote" => Some("'"),
                    "function" => Some("#'"),
                    "`" => Some("`"),
                    "," => Some(","),
                    ",@" => Some(",@"),
                    _ => None,
                };
                if let Some(prefix) = prefix {
                    out.push_str(prefix);
                    print(x, noescape, out);
                    return;
                }
            }
            out.push('(');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                print(item, noescape, out);
            }
            out.push(')');
        }
        // As Emacs prints them, the window without its buffer, which the
        // editor's printer does not see.
        Value::Window(_) | Value::Frame(_) => out.push_str(&value.to_string()),
        other => out.push_str(&format!("#<{other:?}>")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(s: &str) -> Value {
        read_from_string(s, 0).unwrap().0
    }

    #[test]
    fn data_read_and_print_back() {
        for (text, printed) in [
            ("60", "60"),
            ("-3", "-3"),
            ("1.5", "1.5"),
            ("\"sv_SE\"", "\"sv_SE\""),
            ("nil", "nil"),
            ("t", "t"),
            ("()", "nil"),
            ("(a \"b\" 3)", "(a \"b\" 3)"),
            ("'foo", "'foo"),
            ("(quote foo)", "'foo"),
            ("((a . 1) (b . 2))", "((a 1) (b 2))"),
            ("[1 2]", "(1 2)"),
            ("exclusive ; comment", "exclusive"),
            ("\"a\\\"b\\\\c\"", "\"a\\\"b\\\\c\""),
            ("1+", "1+"),
            ("+1", "1"),
            ("-", "-"),
        ] {
            assert_eq!(prin1_to_string(&read(text), false), printed, "{text}");
        }
    }

    #[test]
    fn escapes_and_characters() {
        assert_eq!(read("\"a\\nb\\tc\\x41\\101\\u00e5\""), Value::Str("a\nb\tcAAå".into()));
        assert_eq!(read("?a"), Value::Number(97.0));
        assert_eq!(read("?\\n"), Value::Number(10.0));
        assert_eq!(read("?\\C-a"), Value::Number(1.0));
        assert_eq!(read("foo\\ bar"), Value::Symbol("foo bar".into()));
    }

    #[test]
    fn the_end_of_what_was_read_is_returned() {
        assert_eq!(read_from_string("  60 ; rest", 0).unwrap().1, 4);
        assert_eq!(read_from_string("x \"sv\"y", 1).unwrap(), (Value::Str("sv".into()), 6));
    }

    #[test]
    fn unfinished_and_wrong_data_signal() {
        assert_eq!(read_from_string("(a b", 0).unwrap_err().symbol(), "end-of-file");
        assert_eq!(read_from_string("", 0).unwrap_err().symbol(), "end-of-file");
        assert_eq!(read_from_string(")", 0).unwrap_err().symbol(), "invalid-read-syntax");
    }
}
