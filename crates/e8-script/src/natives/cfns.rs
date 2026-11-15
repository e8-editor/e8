//! fns.c's string and buffer primitives E8 lacked (ADR 0098): base64,
//! comparing and searching strings, a buffer's hash and line statistics,
//! the load average and the locale.

use crate::*;
use crate::natives::{Opt, natives};

fn text(value: &EditorValue) -> Result<String> {
    match value {
        EditorValue::Str(s) => Ok(s.clone()),
        EditorValue::Text(t) => Ok(t.string.clone()),
        other => Err(e8_core::xfaces::wrong_type("stringp", other)),
    }
}

fn given(value: &Opt<EditorValue>) -> bool {
    value.0.as_ref().is_some_and(|v| v.is_true())
}

/// A string's bytes, as base64 takes them: characters U+0000 to U+00FF
/// and raw bytes as themselves; any other character is an error, as Emacs
/// gives for multibyte text.
fn bytes_of(s: &str, what: &str) -> Result<Vec<u8>> {
    s.chars()
        .map(|c| match c as u32 {
            0..=0xFF => Ok(c as u8),
            _ => e8_core::coding::char_raw_byte(c).ok_or_else(|| Error::signal("error", format!("Multibyte character in data for {what}"), Vec::new())),
        })
        .collect()
}

const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/// How long a line of base64 is before Emacs breaks it, as MIME_LINE_LENGTH.
const LINE: usize = 76;

/// Bytes in base64, as base64-encode-1: broken into lines of 76 unless
/// `no_breaks`, padded with `=` unless `no_pad`.
fn encode(bytes: &[u8], url: bool, no_breaks: bool, no_pad: bool) -> String {
    let alphabet = if url { URL } else { STANDARD };
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    let mut column = 0;
    let mut push = |out: &mut String, c: u8| {
        if !no_breaks && column == LINE {
            out.push('\n');
            column = 0;
        }
        out.push(c as char);
        column += 1;
    };
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        let digits = chunk.len() + 1;
        for i in 0..4 {
            if i < digits {
                push(&mut out, alphabet[(n >> (18 - 6 * i) & 63) as usize]);
            } else if !no_pad {
                push(&mut out, b'=');
            }
        }
    }
    out
}

/// Base64 decoded, as base64-decode-1: whitespace skipped, and with
/// `ignore_invalid` anything else not of the alphabet; `None` for data
/// that is not base64.
fn decode(s: &str, url: bool, ignore_invalid: bool) -> Option<Vec<u8>> {
    let value = |c: char| -> Option<u32> {
        match c {
            'A'..='Z' => Some(c as u32 - 'A' as u32),
            'a'..='z' => Some(c as u32 - 'a' as u32 + 26),
            '0'..='9' => Some(c as u32 - '0' as u32 + 52),
            '+' if !url => Some(62),
            '/' if !url => Some(63),
            '-' if url => Some(62),
            '_' if url => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    let mut padding = false;
    for c in s.chars() {
        if c == '=' {
            padding = true;
            continue;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        let Some(v) = value(c) else {
            if ignore_invalid {
                continue;
            }
            return None;
        };
        if padding {
            return None;
        }
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn invalid() -> Error {
    Error::signal("error", "Invalid base64 data", Vec::new())
}

/// The Levenshtein distance between two sequences, as string-distance.
fn distance<T: PartialEq>(a: &[T], b: &[T]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (diagonal + usize::from(x != y)).min(row[j] + 1).min(above + 1);
            diagonal = above;
        }
    }
    row[b.len()]
}

/// A buffer's index, the current one by default.
fn buffer_index(ed: &Editor, buffer: Option<EditorValue>) -> Result<usize> {
    match buffer {
        None | Some(EditorValue::Null) => Ok(ed.buffers().iter().position(|b| b.id() == ed.buffer().id()).unwrap_or(0)),
        Some(EditorValue::Buffer(id)) => ed.buffer_with_id(id).ok_or_else(|| Error::new("Selecting deleted buffer")),
        Some(EditorValue::Str(name)) => ed.buffers().iter().position(|b| b.name == name).ok_or_else(|| Error::new(format!("No such buffer {name}"))),
        Some(other) => Err(e8_core::xfaces::wrong_type("bufferp", &other)),
    }
}

natives! {
    /// A string of bytes in base64, broken into lines of 76 unless `noLineBreak`, as base64-encode-string; a character that is no byte is an error.
    #[ts = "(string: string, noLineBreak?: boolean | null): string"]
    pub fn base64EncodeString(_ed, string: EditorValue, no_line_break: Opt<EditorValue>) -> String {
        Ok(encode(&bytes_of(&text(&string)?, "base64 encoding")?, false, given(&no_line_break), false))
    }

    /// A string of bytes in URL-safe base64 on one line, unpadded with `noPad`, as base64url-encode-string.
    #[ts = "(string: string, noPad?: boolean | null): string"]
    pub fn base64urlEncodeString(_ed, string: EditorValue, no_pad: Opt<EditorValue>) -> String {
        Ok(encode(&bytes_of(&text(&string)?, "base64 encoding")?, true, true, given(&no_pad)))
    }

    /// The bytes base64 stands for, as base64-decode-string: URL-safe with `base64url`, and with `ignoreInvalid` skipping what is not base64.
    #[ts = "(string: string, base64url?: boolean | null, ignoreInvalid?: boolean | null): string"]
    pub fn base64DecodeString(_ed, string: EditorValue, url: Opt<EditorValue>, ignore_invalid: Opt<EditorValue>) -> String {
        let bytes = decode(&text(&string)?, given(&url), given(&ignore_invalid)).ok_or_else(invalid)?;
        Ok(e8_core::coding::string_of_bytes(&bytes))
    }

    /// Replace the region's bytes with their base64, as base64-encode-region; gives the length of the base64.
    #[ts = "(start: number, end: number, noLineBreak?: boolean | null): number"]
    pub fn base64EncodeRegion(ed, start: usize, end: usize, no_line_break: Opt<EditorValue>) -> f64 {
        let (start, end) = (start.min(end), start.max(end));
        let encoded = encode(&bytes_of(&ed.region_text(start, end)?, "base64 encoding")?, false, given(&no_line_break), false);
        ed.replace_range(start, end, &encoded)?;
        Ok(encoded.chars().count() as f64)
    }

    /// Replace the region's bytes with their URL-safe base64, as base64url-encode-region; gives its length.
    #[ts = "(start: number, end: number, noPad?: boolean | null): number"]
    pub fn base64urlEncodeRegion(ed, start: usize, end: usize, no_pad: Opt<EditorValue>) -> f64 {
        let (start, end) = (start.min(end), start.max(end));
        let encoded = encode(&bytes_of(&ed.region_text(start, end)?, "base64 encoding")?, true, true, given(&no_pad));
        ed.replace_range(start, end, &encoded)?;
        Ok(encoded.chars().count() as f64)
    }

    /// Replace the region's base64 with the bytes it stands for, as base64-decode-region; gives how many there are.
    #[ts = "(start: number, end: number, base64url?: boolean | null, ignoreInvalid?: boolean | null): number"]
    pub fn base64DecodeRegion(ed, start: usize, end: usize, url: Opt<EditorValue>, ignore_invalid: Opt<EditorValue>) -> f64 {
        let (start, end) = (start.min(end), start.max(end));
        let bytes = decode(&ed.region_text(start, end)?, given(&url), given(&ignore_invalid)).ok_or_else(invalid)?;
        ed.replace_range(start, end, &e8_core::coding::string_of_bytes(&bytes))?;
        Ok(bytes.len() as f64)
    }

    /// Compare parts of two strings, as compare-strings: true if they are equal, else the place of the first difference plus one, negative where the first string is less.
    #[ts = "(string1: string, start1: number | null, end1: number | null, string2: string, start2: number | null, end2: number | null, ignoreCase?: boolean | null): true | number"]
    pub fn compareStrings(_ed, s1: EditorValue, start1: EditorValue, end1: EditorValue, s2: EditorValue, rest: crate::natives::Rest<EditorValue>) -> EditorValue {
        // The rest as one, as QuickJS binds at most seven arguments.
        let arg = |i: usize| rest.0.get(i).cloned().unwrap_or(EditorValue::Null);
        let (start2, end2) = (arg(0), arg(1));
        let ignore_case = Opt(rest.0.get(2).cloned());
        let (a, b): (Vec<char>, Vec<char>) = (text(&s1)?.chars().collect(), text(&s2)?.chars().collect());
        let bound = |v: &EditorValue, len: usize, default: usize| -> Result<usize> {
            match v.as_number() {
                None => Ok(default),
                Some(n) => {
                    let i = if n < 0.0 { len as f64 + n } else { n };
                    if i < 0.0 || i > len as f64 {
                        return Err(Error::signal("args-out-of-range", "Args out of range", vec![v.clone()]));
                    }
                    Ok(i as usize)
                }
            }
        };
        let (s1, e1) = (bound(&start1, a.len(), 0)?, bound(&end1, a.len(), a.len())?);
        let (s2, e2) = (bound(&start2, b.len(), 0)?, bound(&end2, b.len(), b.len())?);
        let fold = given(&ignore_case);
        let up = |c: char| if fold { c.to_uppercase().next().unwrap_or(c) } else { c };
        let (x, y) = (&a[s1..e1.max(s1)], &b[s2..e2.max(s2)]);
        for (i, (p, q)) in x.iter().zip(y.iter()).enumerate() {
            let (p, q) = (up(*p), up(*q));
            if p != q {
                let n = (i + 1) as f64;
                return Ok(EditorValue::Number(if p < q { -n } else { n }));
            }
        }
        let n = x.len().min(y.len()) as f64 + 1.0;
        Ok(match x.len().cmp(&y.len()) {
            std::cmp::Ordering::Equal => EditorValue::Bool(true),
            std::cmp::Ordering::Less => EditorValue::Number(-n),
            std::cmp::Ordering::Greater => EditorValue::Number(n),
        })
    }

    /// The edit distance between two strings, as string-distance: in characters, or in their UTF-8 bytes with `bytecompare`.
    #[ts = "(string1: string, string2: string, bytecompare?: boolean | null): number"]
    pub fn stringDistance(_ed, s1: EditorValue, s2: EditorValue, bytecompare: Opt<EditorValue>) -> f64 {
        let (a, b) = (text(&s1)?, text(&s2)?);
        Ok(if given(&bytecompare) {
            distance(a.as_bytes(), b.as_bytes())
        } else {
            distance(&a.chars().collect::<Vec<_>>(), &b.chars().collect::<Vec<_>>())
        } as f64)
    }

    /// Where a string is first found in another, from `start`, as string-search; undefined if it is not.
    #[ts = "(needle: string, haystack: string, start?: number | null): number | undefined"]
    pub fn stringSearch(_ed, needle: EditorValue, haystack: EditorValue, start: Opt<EditorValue>) -> Option<f64> {
        let (needle, haystack) = (text(&needle)?, text(&haystack)?);
        let length = haystack.chars().count();
        let start = match start.0.as_ref().and_then(EditorValue::as_number) {
            None => 0,
            Some(n) if n >= 0.0 && n <= length as f64 => n as usize,
            Some(n) => return Err(Error::signal("args-out-of-range", "Args out of range", vec![EditorValue::Number(n)])),
        };
        let from = haystack.char_indices().nth(start).map_or(haystack.len(), |(i, _)| i);
        Ok(haystack[from..].find(&needle).map(|i| (start + haystack[from..from + i].chars().count()) as f64))
    }

    /// Whether a string sorts before another, as string-collate-lessp: by code point, as in the C locale, ignoring case with `ignoreCase`.
    #[ts = "(s1: string, s2: string, locale?: string | null, ignoreCase?: boolean | null): boolean"]
    pub fn stringCollateLessp(_ed, s1: EditorValue, s2: EditorValue, _locale: Opt<EditorValue>, ignore_case: Opt<EditorValue>) -> bool {
        let fold = |s: String| if given(&ignore_case) { s.to_lowercase() } else { s };
        Ok(fold(text(&s1)?) < fold(text(&s2)?))
    }

    /// Whether two strings sort the same, as string-collate-equalp: equal, ignoring case with `ignoreCase`.
    #[ts = "(s1: string, s2: string, locale?: string | null, ignoreCase?: boolean | null): boolean"]
    pub fn stringCollateEqualp(_ed, s1: EditorValue, s2: EditorValue, _locale: Opt<EditorValue>, ignore_case: Opt<EditorValue>) -> bool {
        let fold = |s: String| if given(&ignore_case) { s.to_lowercase() } else { s };
        Ok(fold(text(&s1)?) == fold(text(&s2)?))
    }

    /// The SHA-1 of a buffer's text, the current one by default, as buffer-hash.
    #[ts = "(buffer?: BufferLike | null): string"]
    pub fn bufferHash(ed, buffer: Opt<EditorValue>) -> String {
        let b = &ed.buffers()[buffer_index(ed, buffer.0)?];
        let digest = e8_core::hashes::digest("sha1", &e8_core::hashes::text_bytes(&b.slice(0..b.len())))?;
        Ok(e8_core::hashes::hex(&digest))
    }

    /// How many lines a buffer has, how long its longest is and how long they are on average, in bytes, as buffer-line-statistics.
    #[ts = "(buffer?: BufferLike | null): [lines: number, longest: number, mean: number]"]
    pub fn bufferLineStatistics(ed, buffer: Opt<EditorValue>) -> Vec<f64> {
        let b = &ed.buffers()[buffer_index(ed, buffer.0)?];
        let text = b.slice(0..b.len());
        let mut pieces: Vec<&str> = text.split('\n').collect();
        // The empty piece after a last newline is no line, nor is an empty buffer one.
        if text.is_empty() || text.ends_with('\n') {
            pieces.pop();
        }
        let (mut lines, mut longest, mut mean) = (0usize, 0usize, 0.0f64);
        for line in pieces {
            lines += 1;
            longest = longest.max(line.len());
            // A running mean, as fns.c keeps it.
            mean += (line.len() as f64 - mean) / lines as f64;
        }
        Ok(vec![lines as f64, longest as f64, mean])
    }

    /// The system's load averages over 1, 5 and 15 minutes, as load-average: times 100 and whole, or as they are with `useFloats`.
    #[ts = "(useFloats?: boolean | null): number[]"]
    pub fn loadAverage(_ed, use_floats: Opt<EditorValue>) -> Vec<f64> {
        let loads = e8_core::sysdep::load_average().ok_or_else(|| Error::signal("error", "load-average not implemented for this operating system", Vec::new()))?;
        Ok(loads.iter().map(|&l| if given(&use_floats) { l } else { (l * 100.0).round() }).collect())
    }

    /// What the locale says, as locale-info: codeset gives its coding, days and months their names, paper undefined.
    #[ts = "(item: \"codeset\" | \"days\" | \"months\" | \"paper\"): Value"]
    pub fn localeInfo(_ed, item: EditorValue) -> EditorValue {
        let strings = |names: &[&str]| EditorValue::List(names.iter().map(|n| EditorValue::Str(n.to_string())).collect());
        Ok(match item.as_str() {
            Some("codeset") => {
                let locale = ["LC_ALL", "LC_CTYPE", "LANG"].iter().filter_map(|v| std::env::var(v).ok()).find(|v| !v.is_empty()).unwrap_or_default();
                match locale.split_once('.') {
                    Some((_, codeset)) => EditorValue::Str(codeset.split('@').next().unwrap_or(codeset).to_string()),
                    None => EditorValue::Str("US-ASCII".into()),
                }
            }
            Some("days") => strings(&["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]),
            Some("months") => strings(&["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]),
            _ => EditorValue::Null,
        })
    }

    /// A string's text as multibyte, as string-to-multibyte: E8's strings hold characters already.
    #[ts = "(string: string): string"]
    pub fn stringToMultibyte(_ed, string: EditorValue) -> String {
        text(&string)
    }

    /// A string as the bytes Emacs keeps it in, UTF-8, each a character, as string-as-unibyte.
    #[ts = "(string: string): string"]
    pub fn stringAsUnibyte(_ed, string: EditorValue) -> String {
        Ok(e8_core::coding::string_of_bytes(&e8_core::hashes::text_bytes(&text(&string)?)))
    }
}
