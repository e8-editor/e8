//! Character sets, as Emacs's charset.c: named sets of characters, each
//! with code points of its own, as `encode-char` and `decode-char` convert
//! them. Emacs defines a few hundred; E8 those its coding systems use.

use crate::coding::{Coding, char_raw_byte, raw_byte_char};

/// How a charset's code points map to characters.
#[derive(Clone, Copy, Debug)]
enum Map {
    /// Code points are the characters', from 0 to the limit.
    Unicode(u32),
    /// Emacs's own: Unicode, then the raw bytes.
    Emacs,
    /// Raw bytes, codes 80 to FF.
    EightBit,
    /// A single-byte coding's bytes, all 256 or, for a 96-character ISO
    /// 8859 set, A0 to FF as codes 20 to 7F.
    Bytes(&'static str, bool),
    /// A 94×94 set as an EUC coding holds it, codes with each byte's top
    /// bit clear, with a prefix byte for JIS X 0212's.
    Euc(&'static str, Option<u8>),
    /// A double-byte coding's bytes as the code, as Big5's and GBK's.
    Double(&'static str),
    /// JIS X 0201's katakana, codes 21 to 5F.
    Katakana,
}

struct Charset {
    name: &'static str,
    map: Map,
}

impl Map {
    /// How many bytes a code point of this charset takes, as Emacs's
    /// `:dimension`: one for a single-byte set, two for a 94×94 or
    /// double-byte one, three for Unicode.
    fn dimension(self) -> u32 {
        match self {
            Map::Unicode(limit) if limit <= 0xFF => 1,
            Map::Unicode(limit) if limit <= 0xFFFF => 2,
            Map::Unicode(_) | Map::Emacs => 3,
            Map::EightBit | Map::Bytes(..) | Map::Katakana => 1,
            Map::Euc(..) | Map::Double(_) => 2,
        }
    }

    /// The least and greatest value of each dimension's byte, as Emacs's
    /// `:code-space` holds them, least first.
    fn code_space(self) -> Vec<(u32, u32)> {
        match self {
            Map::Unicode(limit) => (0..self.dimension()).map(|i| (0, (limit >> (8 * i)) & 0xFF)).collect(),
            Map::Emacs => vec![(0, 0xFF), (0, 0xFF), (0, 0x3F)],
            Map::EightBit => vec![(0x80, 0xFF)],
            Map::Bytes(_, upper) => vec![if upper { (0x20, 0x7F) } else { (0, 0xFF) }],
            Map::Euc(..) => vec![(0x21, 0x7E), (0x21, 0x7E)],
            Map::Double("chinese-gbk") => vec![(0x40, 0xFE), (0x81, 0xFE)],
            Map::Double(_) => vec![(0x40, 0xFE), (0xA1, 0xFE)],
            Map::Katakana => vec![(0x21, 0x7E)],
        }
    }

    /// Whether ISO 2022 registered the charset, which is what makes Emacs
    /// take only the low seven bits of each of `make-char`'s codes.
    fn iso_registered(self) -> bool {
        matches!(self, Map::Unicode(0x7F) | Map::Bytes(_, true) | Map::Euc(..) | Map::Katakana)
    }
}

macro_rules! charsets {
    ($(($name:literal, $map:expr)),* $(,)?) => { &[$(Charset { name: $name, map: $map }),*] };
}

/// The charsets, in Emacs's priority order.
static CHARSETS: &[Charset] = charsets![
    ("ascii", Map::Unicode(0x7F)),
    ("iso-8859-1", Map::Unicode(0xFF)),
    ("unicode", Map::Unicode(0x10FFFF)),
    ("latin-iso8859-1", Map::Bytes("iso-latin-1", true)),
    ("iso-8859-2", Map::Bytes("iso-latin-2", false)),
    ("latin-iso8859-2", Map::Bytes("iso-latin-2", true)),
    ("iso-8859-3", Map::Bytes("iso-latin-3", false)),
    ("latin-iso8859-3", Map::Bytes("iso-latin-3", true)),
    ("iso-8859-4", Map::Bytes("iso-latin-4", false)),
    ("latin-iso8859-4", Map::Bytes("iso-latin-4", true)),
    ("iso-8859-5", Map::Bytes("cyrillic-iso-8bit", false)),
    ("cyrillic-iso8859-5", Map::Bytes("cyrillic-iso-8bit", true)),
    ("iso-8859-7", Map::Bytes("greek-iso-8bit", false)),
    ("greek-iso8859-7", Map::Bytes("greek-iso-8bit", true)),
    ("iso-8859-8", Map::Bytes("hebrew-iso-8bit", false)),
    ("hebrew-iso8859-8", Map::Bytes("hebrew-iso-8bit", true)),
    ("iso-8859-9", Map::Bytes("iso-latin-5", false)),
    ("latin-iso8859-9", Map::Bytes("iso-latin-5", true)),
    ("iso-8859-10", Map::Bytes("iso-latin-6", false)),
    ("latin-iso8859-10", Map::Bytes("iso-latin-6", true)),
    ("iso-8859-11", Map::Bytes("iso-8859-11", false)),
    ("thai-iso8859-11", Map::Bytes("iso-8859-11", true)),
    ("iso-8859-13", Map::Bytes("iso-latin-7", false)),
    ("latin-iso8859-13", Map::Bytes("iso-latin-7", true)),
    ("iso-8859-14", Map::Bytes("iso-latin-8", false)),
    ("latin-iso8859-14", Map::Bytes("iso-latin-8", true)),
    ("iso-8859-15", Map::Bytes("iso-latin-9", false)),
    ("latin-iso8859-15", Map::Bytes("iso-latin-9", true)),
    ("iso-8859-16", Map::Bytes("iso-latin-10", false)),
    ("latin-iso8859-16", Map::Bytes("iso-latin-10", true)),
    ("thai-tis620", Map::Bytes("thai-tis620", false)),
    ("chinese-gb2312", Map::Euc("chinese-iso-8bit", None)),
    ("chinese-gbk", Map::Double("chinese-gbk")),
    ("big5", Map::Double("chinese-big5")),
    ("japanese-jisx0208", Map::Euc("japanese-iso-8bit", None)),
    ("japanese-jisx0212", Map::Euc("japanese-iso-8bit", Some(0x8F))),
    ("korean-ksc5601", Map::Euc("korean-iso-8bit", None)),
    ("koi8-r", Map::Bytes("cyrillic-koi8", false)),
    ("cp866", Map::Bytes("cp866", false)),
    ("koi8-u", Map::Bytes("koi8-u", false)),
    ("windows-1250", Map::Bytes("windows-1250", false)),
    ("windows-1251", Map::Bytes("windows-1251", false)),
    ("windows-1252", Map::Bytes("windows-1252", false)),
    ("windows-1253", Map::Bytes("windows-1253", false)),
    ("windows-1254", Map::Bytes("windows-1254", false)),
    ("windows-1255", Map::Bytes("windows-1255", false)),
    ("windows-1256", Map::Bytes("windows-1256", false)),
    ("windows-1257", Map::Bytes("windows-1257", false)),
    ("windows-1258", Map::Bytes("windows-1258", false)),
    ("cp874", Map::Bytes("cp874", false)),
    ("unicode-bmp", Map::Unicode(0xFFFF)),
    ("mac-roman", Map::Bytes("mac-roman", false)),
    ("emacs", Map::Emacs),
    ("eight-bit", Map::EightBit),
    ("katakana-jisx0201", Map::Katakana),
];

/// Emacs's other names for charsets.
const ALIASES: [(&str, &str); 3] = [("ucs", "unicode"), ("iso-10646-1", "unicode"), ("latin-1", "iso-8859-1")];

fn find(name: &str) -> Option<&'static Charset> {
    let name = ALIASES.iter().find(|(alias, _)| *alias == name).map_or(name, |(_, n)| n);
    CHARSETS.iter().find(|c| c.name == name)
}

/// Whether a charset by this name exists, as `charsetp`.
pub fn charsetp(name: &str) -> bool {
    find(name).is_some()
}

/// A charset's properties, as `charset-plist` gives them.
pub type Plist = Vec<(String, crate::variables::Value)>;

/// What an editor keeps of the charsets: the order a script put them in
/// and the properties it put on them. Emacs keeps both in its charset
/// table; E8's table is static, so they live beside it, on the editor.
#[derive(Debug, Default)]
pub struct Charsets {
    /// The charsets `set-charset-priority` put first, most preferred first;
    /// the rest keep the table's own order.
    preferred: Vec<&'static str>,
    /// What `set-charset-plist` put, by charset name.
    plists: Vec<(&'static str, Plist)>,
}

impl Charsets {
    /// The charsets, as `charset-list` gives them, in priority order.
    pub fn charset_list(&self) -> Vec<&'static str> {
        let first = &self.preferred;
        first.iter().copied().chain(CHARSETS.iter().map(|c| c.name).filter(|n| !first.contains(n))).collect()
    }

    /// Puts charsets first in the priority order, as `set-charset-priority`.
    pub fn set_priority(&mut self, names: &[&'static str]) {
        let was: Vec<&'static str> = self.preferred.iter().copied().filter(|n| !names.contains(n)).collect();
        self.preferred = names.iter().copied().chain(was).collect();
    }

    /// Charset names sorted by the priority order, as `sort-charsets`.
    pub fn sort_charsets(&self, names: &[String]) -> Vec<String> {
        let order = self.charset_list();
        let place = |n: &String| find(n).and_then(|c| order.iter().position(|o| *o == c.name)).unwrap_or(usize::MAX);
        let mut names = names.to_vec();
        names.sort_by_key(place);
        names
    }

    /// What E8 knows of a charset as a property list, as `charset-plist`:
    /// its name, dimension, whether it holds ASCII, and its code space,
    /// with what `set-charset-plist` put kept after them.
    pub fn charset_plist(&self, name: &str) -> Option<Plist> {
        use crate::variables::Value;
        let set = find(name)?;
        let num = |n: u32| Value::Number(n as f64);
        let space: Vec<Value> = set.map.code_space().into_iter().flat_map(|(lo, hi)| [num(lo), num(hi)]).collect();
        let ascii = encode_char('a', set.name) == Some(0x61);
        let mut plist = vec![
            (":name".to_string(), Value::Str(set.name.to_string())),
            (":dimension".to_string(), num(set.map.dimension())),
            (":ascii-compatible-p".to_string(), Value::Bool(ascii)),
            (":code-space".to_string(), Value::List(space)),
        ];
        let put = self.plists.iter().find(|(n, _)| *n == set.name).map(|(_, v)| v.clone());
        plist.extend(put.unwrap_or_default());
        Some(plist)
    }

    /// Puts properties on a charset, as `set-charset-plist` does with a
    /// whole plist; the four E8 works out for itself are not stored.
    pub fn set_charset_plist(&mut self, name: &str, props: Plist) -> Option<()> {
        let set = find(name)?.name;
        let own = [":name", ":dimension", ":ascii-compatible-p", ":code-space"];
        let props: Vec<_> = props.into_iter().filter(|(k, _)| !own.contains(&k.as_str())).collect();
        match self.plists.iter_mut().find(|(n, _)| *n == set) {
            Some((_, v)) => *v = props,
            None => self.plists.push((set, props)),
        }
        Some(())
    }

    /// A character's charset and the bytes of its code point in it, most
    /// significant first, as `split-char`.
    pub fn split_char(&self, c: char) -> Option<(&'static str, Vec<u32>)> {
        let name = self.char_charset(c, None)?;
        let code = encode_char(c, name)?;
        let dimension = find(name)?.map.dimension();
        let codes = (0..dimension).rev().map(|i| (code >> (8 * i)) & 0xFF).collect();
        Some((name, codes))
    }

    /// The charsets some text uses, in the charsets' own order, as
    /// `find-charset-string` and `find-charset-region` list them.
    pub fn find_charsets(&self, text: &str) -> Vec<&'static str> {
        let mut found: Vec<&'static str> = Vec::new();
        for c in text.chars() {
            if let Some(name) = self.char_charset(c, None).filter(|n| !found.contains(n)) {
                found.push(name);
            }
        }
        let order = self.charset_list();
        found.sort_by_key(|n| order.iter().position(|o| o == n).unwrap_or(usize::MAX));
        found
    }
}

/// A charset's place in the table, as `charset-id-internal`.
pub fn charset_id(name: &str) -> Option<usize> {
    let name = find(name)?.name;
    CHARSETS.iter().position(|c| c.name == name)
}

/// The charset a name names, under its own name, or `None`.
pub fn canonical_name(name: &str) -> Option<&'static str> {
    find(name).map(|c| c.name)
}

/// The character a charset's position codes name, as `make-char`: the
/// codes are the bytes of the code point, most significant first, and
/// missing ones are the least of their dimension.
pub fn make_char(charset: &str, codes: &[u32]) -> Option<char> {
    let set = find(charset)?;
    let space = set.map.code_space();
    let dimension = space.len();
    if codes.iter().any(|&c| c > 0xFF) {
        return None;
    }
    // Codes past the dimension are ignored, as charset.c reads only as
    // many as the charset has.
    let codes = &codes[..codes.len().min(dimension)];
    if codes.is_empty() {
        // With no code, the charset's least code, or 0 where it holds ASCII.
        let least = space.iter().rev().fold(0, |code, (lo, _)| (code << 8) | lo);
        return decode_char(set.name, if encode_char('a', set.name) == Some(0x61) { 0 } else { least });
    }
    // The codes are most significant first, the dimensions least first,
    // so code N stands for dimension `dimension - N`; those not given are
    // the least of their own dimension.
    let mut code = 0u32;
    for (j, (lo, _)) in space.iter().enumerate().rev() {
        let given = codes.get(dimension - 1 - j).copied();
        code = (code << 8) | given.unwrap_or(*lo);
    }
    // An ISO charset takes the low seven bits of each byte, so EUC's high
    // bytes name the same character as the ISO ones, as charset.c masks them.
    if set.map.iso_registered() {
        code &= 0x7F7F_7F7F;
    }
    decode_char(set.name, code)
}

/// The single byte a coding writes `c` as, if it writes it as one.
fn single_byte(coding: &str, c: char) -> Option<u8> {
    let coding = Coding::named(coding);
    if !coding.can_encode(c) || char_raw_byte(c).is_some() {
        return None;
    }
    match coding.encode_lossy(&c.to_string()).0.as_slice() {
        [b] => Some(*b),
        _ => None,
    }
}

/// The code point of `c` in a charset, as `encode-char`, if it has it.
pub fn encode_char(c: char, charset: &str) -> Option<u32> {
    let n = c as u32;
    match find(charset)?.map {
        Map::Unicode(limit) => (n <= limit && char_raw_byte(c).is_none()).then_some(n),
        Map::Emacs => Some(char_raw_byte(c).map_or(n, |b| 0x3FFF00 + b as u32)),
        Map::EightBit => char_raw_byte(c).map(u32::from),
        Map::Bytes(coding, upper) => {
            let b = single_byte(coding, c)?;
            if upper { (b >= 0xA0).then(|| b as u32 - 0x80) } else { Some(b as u32) }
        }
        Map::Euc(coding, prefix) => {
            let coding = Coding::named(coding);
            if c.is_ascii() || !coding.can_encode(c) {
                return None;
            }
            match (coding.encode_lossy(&c.to_string()).0.as_slice(), prefix) {
                ([a, b], None) if *a >= 0xA1 && *b >= 0xA1 => Some((((a & 0x7F) as u32) << 8) | (b & 0x7F) as u32),
                ([p, a, b], Some(q)) if p == &q => Some((((a & 0x7F) as u32) << 8) | (b & 0x7F) as u32),
                _ => None,
            }
        }
        Map::Double(coding) => {
            let coding = Coding::named(coding);
            if c.is_ascii() || !coding.can_encode(c) {
                return None;
            }
            match coding.encode_lossy(&c.to_string()).0.as_slice() {
                [a, b] => Some(((*a as u32) << 8) | *b as u32),
                _ => None,
            }
        }
        Map::Katakana => (0xFF61..=0xFF9F).contains(&n).then(|| n - 0xFF61 + 0x21),
    }
}

/// The character at a code point of a charset, as `decode-char`.
pub fn decode_char(charset: &str, code: u32) -> Option<char> {
    let decode = |coding: &str, bytes: &[u8]| -> Option<char> {
        let (text, _) = Coding::named(coding).with_eol(Some(crate::coding::Eol::Unix)).decode(bytes);
        let mut chars = text.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if char_raw_byte(c).is_none() => Some(c),
            _ => None,
        }
    };
    match find(charset)?.map {
        Map::Unicode(limit) => (code <= limit).then(|| char::from_u32(code)).flatten(),
        Map::Emacs => match code {
            0x3FFF80..=0x3FFFFF => Some(raw_byte_char((code - 0x3FFF00) as u8)),
            _ => char::from_u32(code),
        },
        Map::EightBit => (0x80..=0xFF).contains(&code).then(|| raw_byte_char(code as u8)),
        Map::Bytes(coding, upper) => {
            let byte = if upper { (0x20..=0x7F).contains(&code).then_some(code + 0x80)? } else { (code <= 0xFF).then_some(code)? };
            decode(coding, &[byte as u8])
        }
        Map::Euc(coding, prefix) => {
            let (a, b) = ((code >> 8) as u8, code as u8);
            if !(0x21..=0x7E).contains(&a) || !(0x21..=0x7E).contains(&b) || code > 0xFFFF {
                return None;
            }
            let bytes: Vec<u8> = prefix.into_iter().chain([a | 0x80, b | 0x80]).collect();
            decode(coding, &bytes)
        }
        Map::Double(coding) => (code > 0xFF && code <= 0xFFFF).then(|| decode(coding, &[(code >> 8) as u8, code as u8])).flatten(),
        Map::Katakana => (0x21..=0x5F).contains(&code).then(|| char::from_u32(0xFF61 + code - 0x21)).flatten(),
    }
}

/// The charset of a character, as `char-charset`: `ascii`, `eight-bit`
/// for a raw byte, else `unicode`, as Emacs's priorities give them; with
/// `restriction`, the first of those charsets that has it.
impl Charsets {
    pub fn char_charset(&self, c: char, restriction: Option<&[String]>) -> Option<&'static str> {
        // A restriction is walked in the order it is given, as charset.c
        // walks the list it is handed.
        if let Some(names) = restriction {
            return names.iter().filter_map(|n| find(n)).find(|set| encode_char(c, set.name).is_some()).map(|set| set.name);
        }
        // ASCII is `ascii` whatever is preferred, as Emacs's CHAR_CHARSET
        // answers before it walks the list at all.
        if c.is_ascii() {
            return Some("ascii");
        }
        // Then the first charset a script preferred that holds the
        // character, as Emacs walks the preferred head of its ordered list;
        // past that head Emacs answers `unicode`, whatever else holds it.
        if let Some(name) = self.preferred.iter().copied().find(|n| encode_char(c, n).is_some()) {
            return Some(name);
        }
        if char_raw_byte(c).is_some() { Some("eight-bit") } else { Some("unicode") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_points_as_emacs_gives_them() {
        assert_eq!(encode_char('あ', "japanese-jisx0208"), Some(0x2422));
        assert_eq!(decode_char("japanese-jisx0208", 0x2422), Some('あ'));
        assert_eq!(encode_char('中', "chinese-gb2312"), Some(22096));
        assert_eq!(encode_char('é', "iso-8859-1"), Some(233));
        assert_eq!(encode_char('é', "unicode"), Some(233));
        assert_eq!(encode_char('é', "latin-iso8859-1"), Some(105));
        assert_eq!(encode_char('ｱ', "katakana-jisx0201"), Some(49));
        assert_eq!(encode_char('ア', "katakana-jisx0201"), None);
        assert_eq!(encode_char('中', "big5"), Some(42148));
        assert_eq!(encode_char('한', "korean-ksc5601"), Some(18257));
        assert_eq!(encode_char('丂', "chinese-gbk"), Some(33088));
        assert_eq!(encode_char(raw_byte_char(0xE9), "eight-bit"), Some(233));
        assert_eq!(encode_char('é', "eight-bit"), None);
        assert_eq!(decode_char("eight-bit", 233), Some(raw_byte_char(0xE9)));
        assert_eq!(decode_char("ucs", 233), Some('é'));
        assert_eq!(decode_char("japanese-jisx0212", 0x3021), Some('丂'));
        let charsets = Charsets::default();
        assert_eq!(charsets.char_charset('a', None), Some("ascii"));
        assert_eq!(charsets.char_charset('é', None), Some("unicode"));
        assert!(charsetp("japanese-jisx0208") && !charsetp("nope"));
    }
}
