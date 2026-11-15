//! The printer and the rest of the Lisp runtime E8's scripts call by
//! Emacs's names (ADR 0102): print.c's output to a buffer, a marker, a
//! function or the echo area; let-bound values' top level; where a
//! variable is bound; and fns.c's and data.c's odds about strings and
//! values that JavaScript answers differently.

use crate::*;
use crate::natives::{Opt, natives};

/// Writes text where `printcharfun` says, as print.c's PRINTCHARFUN: a
/// buffer at its point, a marker, advancing it, a function called with
/// each character, `external-debugging-output` for standard error, and
/// true, or null for `standard-output`'s value, the echo area, or
/// standard output in batch.
fn output(ed: &mut Editor, printcharfun: Option<EditorValue>, text: &str) -> Result<()> {
    let target = match printcharfun {
        None | Some(EditorValue::Null) => ed.variable("standard-output").unwrap_or(EditorValue::Bool(true)),
        Some(v) => v,
    };
    match &target {
        EditorValue::Bool(true) | EditorValue::Null => {
            if ed.noninteractive() {
                use std::io::Write;
                let _ = std::io::stdout().write_all(text.as_bytes());
            } else {
                ed.message(text.trim_end_matches('\n'));
            }
        }
        EditorValue::Buffer(id) => {
            let index = ed.buffer_with_id(*id).ok_or_else(|| Error::new("Selecting deleted buffer"))?;
            let name = ed.buffers()[index].name.clone();
            let here = ed.buffer().name.clone();
            ed.set_current_buffer(&name)?;
            let inserted = ed.insert(text);
            ed.set_current_buffer(&here)?;
            inserted?;
        }
        EditorValue::Marker(id) => {
            let (buffer, pos) = ed.marker_position(*id).map(|(b, p)| (b.to_string(), p)).ok_or_else(|| Error::new("Marker does not point anywhere"))?;
            let here = ed.buffer().name.clone();
            ed.set_current_buffer(&buffer)?;
            let point = ed.buffer().point();
            ed.buffer_mut().set_point(pos);
            let inserted = ed.insert(text);
            let end = ed.buffer().point();
            ed.buffer_mut().set_point(if point >= pos { point + (end - pos) } else { point });
            ed.set_current_buffer(&here)?;
            inserted?;
            ed.set_marker(*id, Some(&buffer), end)?;
        }
        v if v.as_str() == Some("external-debugging-output") => {
            use std::io::Write;
            let _ = std::io::stderr().write_all(text.as_bytes());
        }
        EditorValue::Function(_) | EditorValue::Str(_) | EditorValue::Symbol(_) => {
            for c in text.chars() {
                ed.funcall(&target, &[EditorValue::Number(f64::from(c as u32))])?;
            }
        }
        other => return Err(e8_core::xfaces::wrong_type("functionp", other)),
    }
    Ok(())
}

fn text_of(value: &EditorValue) -> Result<String> {
    match value {
        EditorValue::Str(s) => Ok(s.clone()),
        EditorValue::Text(t) => Ok(t.string.clone()),
        other => Err(e8_core::xfaces::wrong_type("stringp", other)),
    }
}

/// Whether a version string sorts before another, as string-version-lessp:
/// runs of digits compare as numbers, the rest character by character.
fn version_less(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let (x, y): (String, String) = (a[si..i].iter().collect(), b[sj..j].iter().collect());
            let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
            if x.len() != y.len() {
                return x.len() < y.len();
            }
            if x != y {
                return x < y;
            }
        } else {
            if a[i] != b[j] {
                return a[i] < b[j];
            }
            i += 1;
            j += 1;
        }
    }
    a.len() - i < b.len() - j
}

/// Emacs 30's value<: numbers by value, strings and symbols by their text,
/// lists and vectors element by element, buffers and markers by name and place.
fn value_less(ed: &Editor, a: &EditorValue, b: &EditorValue) -> Result<bool> {
    Ok(match (a, b) {
        (EditorValue::Number(x), EditorValue::Number(y)) => x < y,
        (EditorValue::List(x), EditorValue::List(y)) => {
            for (p, q) in x.iter().zip(y) {
                if value_less(ed, p, q)? {
                    return Ok(true);
                }
                if value_less(ed, q, p)? {
                    return Ok(false);
                }
            }
            x.len() < y.len()
        }
        (EditorValue::Buffer(x), EditorValue::Buffer(y)) => {
            let name = |id: u64| ed.buffer_with_id(id).map(|i| ed.buffers()[i].name.clone()).unwrap_or_default();
            name(*x) < name(*y)
        }
        (EditorValue::Marker(x), EditorValue::Marker(y)) => ed.marker_position(*x).map(|(_, p)| p) < ed.marker_position(*y).map(|(_, p)| p),
        (EditorValue::Bool(_) | EditorValue::Null, EditorValue::Bool(_) | EditorValue::Null) => false,
        (x, y) => match (x.as_str(), y.as_str()) {
            (Some(p), Some(q)) => p < q,
            _ => return Err(Error::signal("type-mismatch", "Type mismatch", vec![a.clone(), b.clone()])),
        },
    })
}

thread_local! {
    /// random's state, seeded from the time unless a string seeds it.
    static RANDOM: std::cell::Cell<u64> = std::cell::Cell::new(seed_from_time());
}

fn seed_from_time() -> u64 {
    let nanos = e8_core::clock::system_now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    nanos ^ u64::from(e8_core::clock::process_id()) << 32 | 1
}

/// The next number from a xorshift generator.
fn next_random() -> u64 {
    RANDOM.with(|state| {
        let mut x = state.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        state.set(x);
        x
    })
}

natives! {
    /// Write a value as Lisp writes it, strings quoted, where printcharfun says, as prin1: a buffer, a marker, a function of each character, or the echo area; gives the value.
    #[ts = "(object: Value, printcharfun?: Value, overrides?: Value): Value"]
    pub fn prin1(ed, object: EditorValue, printcharfun: Opt<EditorValue>, _overrides: Opt<EditorValue>) -> EditorValue {
        let text = ed.prin1_to_string(&object, false);
        output(ed, printcharfun.0, &text)?;
        Ok(object)
    }

    /// Write a value as prin1 does, after a newline and before another, as print; gives the value.
    #[ts = "(object: Value, printcharfun?: Value): Value"]
    pub fn print(ed, object: EditorValue, printcharfun: Opt<EditorValue>) -> EditorValue {
        let text = format!("\n{}\n", ed.prin1_to_string(&object, false));
        output(ed, printcharfun.0, &text)?;
        Ok(object)
    }

    /// Write a newline where printcharfun says, as terpri; with `ensure`, only if a buffer's point is not at a line's start, giving whether one was written.
    #[ts = "(printcharfun?: Value, ensure?: boolean | null): boolean"]
    pub fn terpri(ed, printcharfun: Opt<EditorValue>, ensure: Opt<EditorValue>) -> bool {
        if ensure.0.as_ref().is_some_and(|e| e.is_true())
            && let Some(EditorValue::Buffer(id)) = &printcharfun.0
            && let Some(index) = ed.buffer_with_id(*id)
        {
            let b = &ed.buffers()[index];
            let point = b.point();
            if point == 0 || b.char_at(point - 1) == Some('\n') {
                return Ok(false);
            }
        }
        output(ed, printcharfun.0, "\n")?;
        Ok(true)
    }

    /// Write one character where printcharfun says, as write-char; gives the character.
    #[ts = "(char: number, printcharfun?: Value): number"]
    pub fn writeChar(ed, c: f64, printcharfun: Opt<EditorValue>) -> f64 {
        let ch = char::from_u32(c as u32).ok_or_else(|| e8_core::xfaces::wrong_type("characterp", &EditorValue::Number(c)))?;
        output(ed, printcharfun.0, &ch.to_string())?;
        Ok(c)
    }

    /// Write a character to standard error, as external-debugging-output; gives it.
    #[ts = "(char: number): number"]
    pub fn externalDebuggingOutput(_ed, c: f64) -> f64 {
        use std::io::Write;
        if let Some(ch) = char::from_u32(c as u32) {
            let _ = write!(std::io::stderr(), "{ch}");
        }
        Ok(c)
    }

    /// Flush standard output, as flush-standard-output.
    #[ts = "(): undefined"]
    pub fn flushStandardOutput(_ed) -> Option<bool> {
        use std::io::Write;
        let _ = std::io::stdout().flush();
        Ok(None)
    }

    /// The quoting style messages use, as text-quoting-style: the variable's, or curve.
    #[ts = "(): string"]
    pub fn textQuotingStyle(ed) -> String {
        Ok(ed.variable("text-quoting-style").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "curve".into()))
    }

    /// Whether something can be documentation, as documentation-stringp: a string or a number.
    #[ts = "(object: Value): boolean"]
    pub fn documentationStringp(_ed, object: EditorValue) -> bool {
        Ok(matches!(object, EditorValue::Str(_) | EditorValue::Text(_) | EditorValue::Number(_)))
    }

    /// A variable's default value outside every let that binds it, as default-toplevel-value.
    #[ts = "(symbol: string): Value"]
    pub fn defaultToplevelValue(ed, symbol: String) -> EditorValue {
        ed.default_toplevel_value(&symbol).ok_or_else(|| Error::signal("void-variable", format!("Symbol’s value as variable is void: {symbol}"), vec![EditorValue::Symbol(symbol)]))
    }

    /// Set a variable's default value outside every let that binds it, as set-default-toplevel-value.
    #[ts = "(symbol: string, value: Value): undefined"]
    pub fn setDefaultToplevelValue(ed, symbol: String, value: EditorValue) -> Option<bool> {
        ed.set_default_toplevel_value(&symbol, value);
        Ok(None)
    }

    /// Where a variable is bound, as variable-binding-locus: the current buffer if it has its own value, else undefined.
    #[ts = "(variable: string): Buffer | undefined"]
    pub fn variableBindingLocus(ed, variable: String) -> Option<EditorValue> {
        Ok(ed.is_local_variable(&variable).then(|| EditorValue::Buffer(ed.buffer().id())))
    }

    /// Whether a version string sorts before another, numbers in them compared as numbers, as string-version-lessp.
    #[ts = "(string1: string, string2: string): boolean"]
    pub fn stringVersionLessp(_ed, a: EditorValue, b: EditorValue) -> bool {
        Ok(version_less(&text_of(&a)?, &text_of(&b)?))
    }

    /// How many bytes Emacs keeps a string in, as string-bytes: UTF-8, a raw byte one.
    #[ts = "(string: string): number"]
    pub fn stringBytes(_ed, string: EditorValue) -> f64 {
        Ok(text_of(&string)?.chars().map(|c| if e8_core::coding::char_raw_byte(c).is_some() { 1 } else { c.len_utf8() }).sum::<usize>() as f64)
    }

    /// Whether a value is a string with characters past ASCII that are not raw bytes, as multibyte-string-p.
    #[ts = "(object: Value): boolean"]
    pub fn multibyteStringP(_ed, object: EditorValue) -> bool {
        Ok(match &object {
            EditorValue::Str(_) | EditorValue::Text(_) => object.as_str().unwrap_or("").chars().any(|c| !c.is_ascii() && e8_core::coding::char_raw_byte(c).is_none()),
            _ => false,
        })
    }

    /// A string of characters below 256 as bytes, as string-to-unibyte; any other is an error.
    #[ts = "(string: string): string"]
    pub fn stringToUnibyte(_ed, string: EditorValue) -> String {
        let s = text_of(&string)?;
        for (i, c) in s.chars().enumerate() {
            if c as u32 > 0xFF && e8_core::coding::char_raw_byte(c).is_none() {
                return Err(Error::signal("error", format!("Cannot convert character at index {i} to unibyte"), Vec::new()));
            }
        }
        Ok(s.chars().map(|c| e8_core::coding::char_raw_byte(c).map_or(c, char::from)).collect())
    }

    /// A string as bytes, each character's low eight bits, as string-make-unibyte.
    #[ts = "(string: string): string"]
    pub fn stringMakeUnibyte(_ed, string: EditorValue) -> String {
        Ok(text_of(&string)?.chars().map(|c| char::from(e8_core::coding::char_raw_byte(c).unwrap_or(c as u32 as u8))).collect())
    }

    /// A random number, as random: below `limit` when it is a positive number, from a seed when it is a string, reseeded from the time when it is true.
    #[ts = "(limit?: number | string | true | null): number"]
    pub fn random(_ed, limit: Opt<EditorValue>) -> f64 {
        match &limit.0 {
            Some(EditorValue::Bool(true)) => RANDOM.with(|s| s.set(seed_from_time())),
            Some(EditorValue::Str(seed)) => {
                // FNV-1a of the seed, so the same string gives the same numbers.
                let h = seed.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
                RANDOM.with(|s| s.set(h | 1));
            }
            _ => {}
        }
        let n = next_random();
        Ok(match limit.0.as_ref().and_then(EditorValue::as_number) {
            Some(l) if l >= 1.0 => (n % l as u64) as f64,
            _ => ((n >> 11) as i64 - (1i64 << 52)) as f64,
        })
    }

    /// Whether a value sorts before another, as Emacs 30's value<: numbers, strings and symbols, lists element by element, buffers and markers.
    #[ts = "(a: Value, b: Value): boolean"]
    pub fn valueLess(ed, a: EditorValue, b: EditorValue) -> bool {
        value_less(ed, &a, &b)
    }
}
