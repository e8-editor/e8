//! Lisp's `format` and `format-message`, as editfns.c's `styled_format`
//! (ADR 0090): `%[FIELD$][FLAGS][WIDTH][.PRECISION]CHAR`, with CHAR one
//! of `s` (as `princ`), `S` (as `prin1`), `d`, `o`, `x`, `X`, `c`, `e`,
//! `f`, `g` and `%`, the flags `-`, `+`, space, `0` and `#`, and Emacs's
//! errors. `format-message` also turns the format string's grave accents
//! and apostrophes into curved quotes, as `text-quoting-style` says.

use crate::error::{Error, Result};
use crate::variables::Value;

fn error(message: &str) -> Error {
    Error::new(message)
}

/// The number a value is, as the numeric conversions take one.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

/// Pads `body` to `width`, on the right with `-`, else on the left with
/// spaces, or with zeros after any sign for a number with `0`.
fn pad(body: String, width: usize, left: bool, zero: bool) -> String {
    let len = body.chars().count();
    if len >= width {
        return body;
    }
    let fill = width - len;
    if left {
        return body + &" ".repeat(fill);
    }
    if zero {
        let (sign, digits) = match body.chars().next() {
            Some(c @ ('-' | '+' | ' ')) => (c.to_string(), body[1..].to_string()),
            _ => (String::new(), body.clone()),
        };
        // A prefix such as 0x keeps the zeros after it.
        let (prefix, digits) = match digits.get(..2) {
            Some(p @ ("0x" | "0X")) => (p.to_string(), digits[2..].to_string()),
            _ => (String::new(), digits),
        };
        return format!("{sign}{prefix}{}{digits}", "0".repeat(fill));
    }
    " ".repeat(fill) + &body
}

/// A number in C's `%e`: one digit, a point, PRECISION digits and a two-digit exponent at least.
fn exponential(n: f64, precision: usize) -> String {
    let s = format!("{n:.precision$e}");
    match s.split_once('e') {
        Some((mantissa, exp)) => {
            let (sign, digits) = exp.strip_prefix('-').map_or(("+", exp), |d| ("-", d));
            format!("{mantissa}e{sign}{digits:0>2}")
        }
        None => s,
    }
}

/// A number in C's `%g`: the shorter of `%e` and `%f` at PRECISION
/// significant digits, its trailing zeros dropped unless `#`.
fn general(n: f64, precision: usize, alternate: bool) -> String {
    let p = precision.max(1);
    if n == 0.0 {
        return if alternate { format!("{:.*}", p - 1, 0.0) } else { "0".into() };
    }
    let exp = n.abs().log10().floor() as i32;
    let s = if exp < -4 || exp >= p as i32 { exponential(n, p - 1) } else { format!("{n:.*}", (p as i32 - 1 - exp).max(0) as usize) };
    if alternate {
        return s;
    }
    match s.split_once('e') {
        Some((mantissa, exp)) => {
            let mantissa = if mantissa.contains('.') { mantissa.trim_end_matches('0').trim_end_matches('.') } else { mantissa };
            format!("{mantissa}e{exp}")
        }
        None if s.contains('.') => s.trim_end_matches('0').trim_end_matches('.').to_string(),
        None => s,
    }
}

/// How a number prints with `%s`: a whole number without a point.
fn princ_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e17 { format!("{}", n as i64) } else { format!("{n}") }
}

/// Formats ARGS by FORMAT as Lisp's `format`; `print` writes a value as
/// `prin1` (`escape`) or `princ` does.
pub fn format(format: &str, args: &[Value], print: &dyn Fn(&Value, bool) -> String) -> Result<String> {
    let chars: Vec<char> = format.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut next_arg = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c != '%' {
            out.push(c);
            i += 1;
            continue;
        }
        i += 1;
        // A field number, N$.
        let start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        if i < chars.len() && chars[i] == '$' && i > start {
            let n: usize = chars[start..i].iter().collect::<String>().parse().unwrap_or(1);
            next_arg = n.saturating_sub(1);
            i += 1;
        } else {
            i = start;
        }
        let (mut left, mut plus, mut space, mut zero, mut alternate) = (false, false, false, false, false);
        while i < chars.len() {
            match chars[i] {
                '-' => left = true,
                '+' => plus = true,
                ' ' => space = true,
                '0' => zero = true,
                '#' => alternate = true,
                _ => break,
            }
            i += 1;
        }
        let digits = |i: &mut usize| {
            let s = *i;
            while *i < chars.len() && chars[*i].is_ascii_digit() {
                *i += 1;
            }
            (*i > s).then(|| chars[s..*i].iter().collect::<String>().parse::<usize>().unwrap_or(0))
        };
        let width = digits(&mut i).unwrap_or(0);
        let precision = if i < chars.len() && chars[i] == '.' {
            i += 1;
            Some(digits(&mut i).unwrap_or(0))
        } else {
            None
        };
        let Some(&conversion) = chars.get(i) else { return Err(error("Format string ends in middle of format specifier")) };
        i += 1;
        if conversion == '%' {
            out.push('%');
            continue;
        }
        if !"sSdoxXcefg".contains(conversion) {
            return Err(Error::new(format!("Invalid format operation %{conversion}")));
        }
        let Some(arg) = args.get(next_arg) else { return Err(error("Not enough arguments for format string")) };
        next_arg += 1;
        let sign = |n: f64, body: String| if n < 0.0 || body.starts_with('-') { body } else if plus { format!("+{body}") } else if space { format!(" {body}") } else { body };
        let body = match conversion {
            's' | 'S' => {
                let text = match (conversion, arg) {
                    ('s', Value::Number(n)) => princ_number(*n),
                    (_, v) => print(v, conversion == 'S'),
                };
                let text = match precision {
                    Some(p) => text.chars().take(p).collect(),
                    None => text,
                };
                out.push_str(&pad(text, width, left, false));
                continue;
            }
            'c' => {
                let Some(c) = number(arg).and_then(|n| char::from_u32(n as u32)) else { return Err(error("Format specifier doesn’t match argument type")) };
                out.push_str(&pad(c.to_string(), width, left, false));
                continue;
            }
            'd' | 'o' | 'x' | 'X' => {
                let Some(n) = number(arg) else { return Err(error("Format specifier doesn’t match argument type")) };
                let whole = n.trunc() as i64;
                let magnitude = whole.unsigned_abs();
                let mut digits = match conversion {
                    'd' => magnitude.to_string(),
                    'o' => format!("{magnitude:o}"),
                    'x' => format!("{magnitude:x}"),
                    _ => format!("{magnitude:X}"),
                };
                if let Some(p) = precision {
                    while digits.len() < p {
                        digits.insert(0, '0');
                    }
                }
                if alternate && magnitude != 0 {
                    match conversion {
                        'o' => digits.insert(0, '0'),
                        'x' => digits.insert_str(0, "0x"),
                        'X' => digits.insert_str(0, "0X"),
                        _ => {}
                    }
                }
                let body = if whole < 0 { format!("-{digits}") } else { digits };
                sign(n, body)
            }
            _ => {
                let Some(n) = number(arg) else { return Err(error("Format specifier doesn’t match argument type")) };
                let p = precision.unwrap_or(6);
                let body = match conversion {
                    'e' => exponential(n, p),
                    'f' => format!("{n:.p$}"),
                    _ => general(n, p, alternate),
                };
                let body = if alternate && conversion != 'g' && p == 0 && !body.contains('.') { body + "." } else { body };
                sign(n, body)
            }
        };
        // A precision on an integer turns the zero flag off, as C's does.
        let zero = zero && !left && !(precision.is_some() && "doxX".contains(conversion));
        out.push_str(&pad(body, width, left, zero));
    }
    Ok(out)
}

/// The format string with its grave accents and apostrophes curved, as
/// `format-message` sees it under `text-quoting-style` STYLE: `curve` (the
/// default) gives ‘ and ’, `straight` ' and ', and `grave` leaves them.
pub fn quote_message(format: &str, style: Option<&str>) -> String {
    match style {
        Some("grave") => format.to_string(),
        Some("straight") => format.replace('`', "'"),
        _ => format.replace('`', "\u{2018}").replace('\'', "\u{2019}"),
    }
}
