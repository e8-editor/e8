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
    /// A charset a script defined with `define-charset-internal`.
    Defined(&'static Defined),
}

/// A charset `define-charset-internal` defined: its code space and how
/// its code points map to characters (ADR 0095).
#[derive(Debug)]
pub struct Defined {
    /// Each dimension's least and greatest byte, least significant first.
    code_space: Vec<(u32, u32)>,
    min_code: u32,
    max_code: u32,
    iso_final: Option<u8>,
    how: How,
}

/// How a defined charset's code points become characters.
#[derive(Debug)]
enum How {
    /// The character is `offset` plus the code's distance from the least
    /// code, as `:code-offset`.
    Offset(u32),
    /// Another charset's codes from `min` to `max`, each this charset's
    /// code less `offset`, as `:subset`.
    Subset { parent: &'static str, min: u32, max: u32, offset: u32 },
    /// The codes of other charsets, each moved by its offset, the first
    /// that has a character winning, as `:superset`.
    Superset(Vec<(&'static str, u32)>),
    /// Characters from a map file, which E8 does not read: none.
    Unmapped,
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
            Map::Defined(d) => d.code_space.len() as u32,
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
            Map::Defined(d) => d.code_space.clone(),
        }
    }

    /// Whether ISO 2022 registered the charset, which is what makes Emacs
    /// take only the low seven bits of each of `make-char`'s codes.
    fn iso_registered(self) -> bool {
        match self {
            Map::Defined(d) => d.iso_final.is_some(),
            _ => matches!(self, Map::Unicode(0x7F) | Map::Bytes(_, true) | Map::Euc(..) | Map::Katakana),
        }
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

thread_local! {
    /// The charsets `define-charset-internal` defined, newest last, kept
    /// for the life of the thread, as Emacs keeps a charset for its life.
    static DEFINED: std::cell::RefCell<Vec<&'static Charset>> = const { std::cell::RefCell::new(Vec::new()) };
    /// Other names `define-charset-alias` gave charsets.
    static MORE_ALIASES: std::cell::RefCell<Vec<(&'static str, &'static str)>> = const { std::cell::RefCell::new(Vec::new()) };
    /// The charsets ISO 2022 names by dimension, 94 or 96 characters and
    /// final byte, as charset.c's iso_charset_table: E8's own, then those
    /// defined or declared, the last one winning.
    static ISO: std::cell::RefCell<Vec<IsoName>> = std::cell::RefCell::new(ISO_FINALS.to_vec());
}

/// The final byte ISO 2022 names a charset by, as its `:iso-final-char`:
/// the one it was registered or declared with last.
fn iso_final(charset: &str) -> Option<u8> {
    ISO.with(|t| t.borrow().iter().rev().find(|(_, n)| *n == charset).map(|((.., f), _)| *f))
}

// What Emacs 30 says of the charsets E8 has too, written from Emacs's
// `charset-plist` by tests/emacs/coding-plists.el: each one's docstring, short and long names,
// `emacs-mule` id and the map its characters unify through. E8 builds its
// charsets rather than loading maps, so the map is only named.
type EmacsCharset = (&'static str, &'static str, &'static str, &'static str, Option<u32>, Option<&'static str>);
static EMACS_CHARSETS: &[EmacsCharset] = &[
    ("ascii", "ASCII (ISO646 IRV)", "ASCII", "ASCII (ISO646 IRV)", Some(0), None),
    ("iso-8859-1", "Latin-1 (ISO/IEC 8859-1)", "Latin-1", "Latin-1", None, None),
    ("unicode", "Unicode (ISO10646)", "Unicode", "Unicode (ISO10646)", None, None),
    ("latin-iso8859-1", "Right-Hand Part of ISO/IEC 8859/1 (Latin-1): ISO-IR-100", "RHP of Latin-1", "RHP of ISO/IEC 8859/1 (Latin-1): ISO-IR-100", Some(129), None),
    ("iso-8859-2", "ISO/IEC 8859/2", "Latin-2", "ISO/IEC 8859/2", None, None),
    ("latin-iso8859-2", "Right-Hand Part of ISO/IEC 8859/2 (Latin-2): ISO-IR-101", "RHP of ISO/IEC 8859/2", "RHP of ISO/IEC 8859/2 (Latin-2)", Some(130), None),
    ("iso-8859-3", "ISO/IEC 8859/3", "Latin-3", "ISO/IEC 8859/3", None, None),
    ("latin-iso8859-3", "Right-Hand Part of ISO/IEC 8859/3 (Latin-3): ISO-IR-109", "RHP of ISO/IEC 8859/3", "RHP of ISO/IEC 8859/3 (Latin-3)", Some(131), None),
    ("iso-8859-4", "ISO/IEC 8859/4", "Latin-4", "ISO/IEC 8859/4", None, None),
    ("latin-iso8859-4", "Right-Hand Part of ISO/IEC 8859/4 (Latin-4): ISO-IR-110", "RHP of ISO/IEC 8859/4", "RHP of ISO/IEC 8859/4 (Latin-4)", Some(132), None),
    ("iso-8859-5", "ISO/IEC 8859/5", "Latin/Cyrillic", "ISO/IEC 8859/5", None, None),
    ("cyrillic-iso8859-5", "Right-Hand Part of ISO/IEC 8859/5 (Latin/Cyrillic): ISO-IR-144", "RHP of ISO/IEC 8859/5", "RHP of ISO/IEC 8859/5 (Latin/Cyrillic)", Some(140), None),
    ("iso-8859-7", "ISO/IEC 8859/7", "Latin/Greek", "ISO/IEC 8859/7", None, None),
    ("greek-iso8859-7", "Right-Hand Part of ISO/IEC 8859/7 (Latin/Greek): ISO-IR-126", "RHP of ISO/IEC 8859/7", "RHP of ISO/IEC 8859/7 (Latin/Greek)", Some(134), None),
    ("iso-8859-8", "ISO/IEC 8859/8", "Latin/Hebrew", "ISO/IEC 8859/8", None, None),
    ("hebrew-iso8859-8", "Right-Hand Part of ISO/IEC 8859/8 (Latin/Hebrew): ISO-IR-138", "RHP of ISO/IEC 8859/8", "RHP of ISO/IEC 8859/8 (Latin/Hebrew)", Some(136), None),
    ("iso-8859-9", "ISO/IEC 8859/9", "Latin-5", "ISO/IEC 8859/9", None, None),
    ("latin-iso8859-9", "Right-Hand Part of ISO/IEC 8859/9 (Latin-5): ISO-IR-148", "RHP of ISO/IEC 8859/9", "RHP of ISO/IEC 8859/9 (Latin-5)", Some(141), None),
    ("iso-8859-10", "ISO/IEC 8859/10", "Latin-6", "ISO/IEC 8859/10", None, None),
    ("latin-iso8859-10", "Right-Hand Part of ISO/IEC 8859/10 (Latin-6): ISO-IR-157", "RHP of ISO/IEC 8859/10", "RHP of ISO/IEC 8859/10 (Latin-6)", None, None),
    ("iso-8859-11", "ISO/IEC 8859/11", "Latin/Thai", "ISO/IEC 8859/11", None, None),
    ("thai-iso8859-11", "Right-Hand Part of ISO/IEC 8859/11 (Latin/Thai): ISO-IR-166", "RHP of ISO/IEC 8859/11", "RHP of ISO/IEC 8859/11 (Latin/Thai)", None, None),
    ("iso-8859-13", "ISO/IEC 8859/13", "Latin-7", "ISO/IEC 8859/13", None, None),
    ("latin-iso8859-13", "Right-Hand Part of ISO/IEC 8859/13 (Latin-7): ISO-IR-179", "RHP of ISO/IEC 8859/13", "RHP of ISO/IEC 8859/13 (Latin-7)", None, None),
    ("iso-8859-14", "ISO/IEC 8859/14", "Latin-8", "ISO/IEC 8859/14", None, None),
    ("latin-iso8859-14", "Right-Hand Part of ISO/IEC 8859/14 (Latin-8): ISO-IR-199", "RHP of ISO/IEC 8859/14", "RHP of ISO/IEC 8859/14 (Latin-8)", Some(143), None),
    ("iso-8859-15", "ISO/IEC 8859/15", "Latin-9", "ISO/IEC 8859/15", None, None),
    ("latin-iso8859-15", "Right-Hand Part of ISO/IEC 8859/15 (Latin-9): ISO-IR-203", "RHP of ISO/IEC 8859/15", "RHP of ISO/IEC 8859/15 (Latin-9)", Some(142), None),
    ("iso-8859-16", "ISO/IEC 8859/16", "Latin-10", "ISO/IEC 8859/16", None, None),
    ("latin-iso8859-16", "Right-Hand Part of ISO/IEC 8859/16 (Latin-10): ISO-IR-226", "RHP of ISO/IEC 8859/16", "RHP of ISO/IEC 8859/16 (Latin-10)", None, None),
    ("thai-tis620", "MULE charset for TIS620.2533", "TIS620.2533", "TIS620.2533", Some(133), None),
    ("chinese-gb2312", "GB2312 Chinese simplified: ISO-IR-58", "GB2312", "GB2312: ISO-IR-58", Some(145), Some("GB2312")),
    ("chinese-gbk", "GBK Chinese simplified.", "GBK", "GBK", None, Some("GBK")),
    ("big5", "Big5 (Chinese traditional)", "Big5", "Big5", None, Some("BIG5")),
    ("japanese-jisx0208", "JISX0208.1983/1990 Japanese Kanji: ISO-IR-87", "JISX0208", "JISX0208.1983/1990 (Japanese): ISO-IR-87", Some(146), Some("JISX0208")),
    ("japanese-jisx0212", "JISX0212 Japanese supplement: ISO-IR-159", "JISX0212", "JISX0212 (Japanese): ISO-IR-159", Some(148), Some("JISX0212")),
    ("korean-ksc5601", "KSC5601 Korean Hangul and Hanja: ISO-IR-149", "KSC5601", "KSC5601 (Korean): ISO-IR-149", Some(147), Some("KSC5601")),
    ("koi8-r", "KOI8-R", "KOI8-R", "KOI8-R", None, None),
    ("cp866", "CP866", "cp866", "cp866", None, None),
    ("koi8-u", "KOI8-U", "KOI8-U", "KOI8-U", None, None),
    ("windows-1250", "WINDOWS-1250 (Central Europe)", "WINDOWS-1250", "WINDOWS-1250", None, None),
    ("windows-1251", "WINDOWS-1251 (Cyrillic)", "WINDOWS-1251", "WINDOWS-1251", None, None),
    ("windows-1252", "WINDOWS-1252 (Latin I)", "WINDOWS-1252", "WINDOWS-1252", None, None),
    ("windows-1253", "WINDOWS-1253 (Greek)", "WINDOWS-1253", "WINDOWS-1253", None, None),
    ("windows-1254", "WINDOWS-1254 (Turkish)", "WINDOWS-1254", "WINDOWS-1254", None, None),
    ("windows-1255", "WINDOWS-1255 (Hebrew)", "WINDOWS-1255", "WINDOWS-1255", None, None),
    ("windows-1256", "WINDOWS-1256 (Arabic)", "WINDOWS-1256", "WINDOWS-1256", None, None),
    ("windows-1257", "WINDOWS-1257 (Baltic)", "WINDOWS-1257", "WINDOWS-1257", None, None),
    ("windows-1258", "WINDOWS-1258 (Viet Nam)", "WINDOWS-1258", "WINDOWS-1258", None, None),
    ("cp874", "CP874 (IBM Thai)", "CP874", "CP874", None, None),
    ("unicode-bmp", "Unicode Basic Multilingual Plane (U+0000..U+FFFF)", "Unicode BMP", "Unicode BMP", None, None),
    ("mac-roman", "Mac Roman charset", "Mac Roman", "Mac Roman", None, None),
    ("emacs", "Full Emacs charset (excluding eight bit chars)", "Emacs", "Emacs", None, None),
    ("eight-bit", "Raw bytes 128-255", "Raw bytes", "", None, None),
    ("katakana-jisx0201", "Katakana Part of JISX0201.1976", "JISX0201 Katakana", "Japanese Katakana (JISX0201.1976)", Some(137), None),
];

/// A charset as ISO 2022 names it: by dimension, 94 or 96 characters and final byte.
type IsoName = ((u32, u32, u8), &'static str);

/// The ISO 2022 finals of E8's own charsets, as Emacs registers them.
const ISO_FINALS: [IsoName; 21] = [
    ((1, 94, b'B'), "ascii"),
    ((1, 96, b'A'), "latin-iso8859-1"),
    ((1, 96, b'B'), "latin-iso8859-2"),
    ((1, 96, b'C'), "latin-iso8859-3"),
    ((1, 96, b'D'), "latin-iso8859-4"),
    ((1, 96, b'L'), "cyrillic-iso8859-5"),
    ((1, 96, b'F'), "greek-iso8859-7"),
    ((1, 96, b'H'), "hebrew-iso8859-8"),
    ((1, 96, b'M'), "latin-iso8859-9"),
    ((1, 96, b'V'), "latin-iso8859-10"),
    ((1, 96, b'T'), "thai-iso8859-11"),
    ((1, 96, b'Y'), "latin-iso8859-13"),
    ((1, 96, b'_'), "latin-iso8859-14"),
    ((1, 96, b'b'), "latin-iso8859-15"),
    ((1, 96, b'f'), "latin-iso8859-16"),
    ((1, 96, b'T'), "thai-tis620"),
    ((2, 94, b'A'), "chinese-gb2312"),
    ((2, 94, b'B'), "japanese-jisx0208"),
    ((2, 94, b'D'), "japanese-jisx0212"),
    ((2, 94, b'C'), "korean-ksc5601"),
    ((1, 94, b'I'), "katakana-jisx0201"),
];

fn find(name: &str) -> Option<&'static Charset> {
    let name = ALIASES.iter().find(|(alias, _)| *alias == name).map_or(name, |(_, n)| n);
    let name = MORE_ALIASES.with(|a| a.borrow().iter().find(|(alias, _)| *alias == name).map(|(_, n)| *n)).unwrap_or(name);
    CHARSETS.iter().find(|c| c.name == name).or_else(|| DEFINED.with(|d| d.borrow().iter().find(|c| c.name == name).copied()))
}

/// The charsets defined, newest first, as `charset-list` puts them.
fn defined_names() -> Vec<&'static str> {
    DEFINED.with(|d| d.borrow().iter().rev().map(|c| c.name).collect())
}

/// What a charset is to be, as `define-charset-internal` takes it.
#[derive(Clone, Debug, Default)]
pub struct Definition {
    pub name: String,
    /// Each dimension's least and greatest byte, least significant first.
    pub code_space: Vec<(u32, u32)>,
    pub min_code: Option<u32>,
    pub max_code: Option<u32>,
    pub iso_final: Option<u8>,
    pub code_offset: Option<u32>,
    /// `:subset`: the parent, its least and greatest codes, and the offset.
    pub subset: Option<(String, u32, u32, u32)>,
    /// `:superset`: each charset with the offset of its codes.
    pub superset: Option<Vec<(String, u32)>>,
}

fn leak(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

/// Defines a charset, or defines it again, as `define-charset-internal`.
/// A charset E8 has built in under that name is left as it is. `Err`
/// says why it cannot be defined.
pub fn define_charset(def: &Definition) -> Result<(), String> {
    if CHARSETS.iter().any(|c| c.name == def.name) {
        return Ok(());
    }
    if def.code_space.is_empty() || def.code_space.len() > 4 || def.code_space.iter().any(|(lo, hi)| lo > hi || *hi > 0xFF) {
        return Err("Invalid code space".into());
    }
    let parent = |name: &str| canonical_name(name).ok_or_else(|| format!("Invalid charset: {name}"));
    let how = if let Some((name, min, max, offset)) = &def.subset {
        How::Subset { parent: parent(name)?, min: *min, max: *max, offset: *offset }
    } else if let Some(list) = &def.superset {
        How::Superset(list.iter().map(|(n, o)| Ok((parent(n)?, *o))).collect::<Result<_, String>>()?)
    } else if let Some(offset) = def.code_offset {
        How::Offset(offset)
    } else {
        How::Unmapped
    };
    let least = def.code_space.iter().rev().fold(0, |code, (lo, _)| (code << 8) | lo);
    let greatest = def.code_space.iter().rev().fold(0, |code, (_, hi)| (code << 8) | hi);
    let defined: &'static Defined = Box::leak(Box::new(Defined {
        code_space: def.code_space.clone(),
        min_code: def.min_code.unwrap_or(least),
        max_code: def.max_code.unwrap_or(greatest),
        iso_final: def.iso_final,
        how,
    }));
    let charset: &'static Charset = Box::leak(Box::new(Charset { name: leak(&def.name), map: Map::Defined(defined) }));
    DEFINED.with(|d| {
        let mut d = d.borrow_mut();
        d.retain(|c| c.name != def.name);
        d.push(charset);
    });
    if let Some(final_byte) = def.iso_final {
        let (lo, hi) = def.code_space[0];
        declare_iso(def.code_space.len() as u32, if hi - lo + 1 == 96 { 96 } else { 94 }, final_byte, charset.name);
    }
    Ok(())
}

/// Gives a charset another name, as `define-charset-alias`; false if it names none.
pub fn define_alias(alias: &str, charset: &str) -> bool {
    let Some(target) = canonical_name(charset) else { return false };
    MORE_ALIASES.with(|a| {
        let mut a = a.borrow_mut();
        a.retain(|(n, _)| *n != alias);
        a.push((leak(alias), target));
    });
    true
}

fn declare_iso(dimension: u32, chars: u32, final_byte: u8, charset: &'static str) {
    ISO.with(|t| {
        let mut t = t.borrow_mut();
        t.retain(|(key, _)| *key != (dimension, chars, final_byte));
        t.push(((dimension, chars, final_byte), charset));
    });
}

/// Makes ISO 2022's charset of a dimension, 94 or 96 characters and final
/// byte this one, as `declare-equiv-charset`; false if it names none.
pub fn declare_equiv_charset(dimension: u32, chars: u32, final_byte: u8, charset: &str) -> bool {
    let Some(name) = canonical_name(charset) else { return false };
    declare_iso(dimension, chars, final_byte, name);
    true
}

/// The charset ISO 2022 names by a dimension, 94 or 96 characters and a
/// final byte, as `iso-charset`.
pub fn iso_charset(dimension: u32, chars: u32, final_byte: u8) -> Option<&'static str> {
    ISO.with(|t| t.borrow().iter().rev().find(|(key, _)| *key == (dimension, chars, final_byte)).map(|(_, n)| *n))
}

/// The first final byte of ISO 2022's private ones, `0` to `?`, that no
/// charset of a dimension and 94 or 96 characters has, as
/// `get-unused-iso-final-char`.
pub fn unused_iso_final(dimension: u32, chars: u32) -> Option<u8> {
    (b'0'..=b'?').find(|&f| iso_charset(dimension, chars, f).is_none())
}

/// The ranges of characters a charset's codes from `from` to `to` hold,
/// each as its first and last character, as `map-charset-chars` calls its
/// function with them.
pub fn charset_char_ranges(charset: &str, from: Option<u32>, to: Option<u32>) -> Option<Vec<(char, char)>> {
    let set = find(charset)?;
    let space = set.map.code_space();
    let least = space.iter().rev().fold(0, |code, (lo, _)| (code << 8) | lo);
    let greatest = space.iter().rev().fold(0, |code, (_, hi)| (code << 8) | hi);
    let (from, to) = (from.unwrap_or(least).max(least), to.unwrap_or(greatest).min(greatest));
    let in_space = |code: u32| space.iter().enumerate().all(|(i, &(lo, hi))| (lo..=hi).contains(&((code >> (8 * i)) & 0xFF)));
    let mut ranges: Vec<(char, char)> = Vec::new();
    let mut code = from;
    while code <= to {
        if in_space(code)
            && let Some(c) = decode_char(set.name, code)
        {
            match ranges.last_mut() {
                Some((_, last)) if *last as u32 + 1 == c as u32 => *last = c,
                _ => ranges.push((c, c)),
            }
        }
        code += 1;
    }
    Some(ranges)
}

/// How many bytes a charset writes a code point in, as its `:dimension`.
pub fn charset_dimension(name: &str) -> Option<u32> {
    find(name).map(|c| c.map.dimension())
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
        let rest = defined_names().into_iter().chain(CHARSETS.iter().map(|c| c.name));
        first.iter().copied().chain(rest.filter(|n| !first.contains(n))).collect()
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

    /// A charset's properties, as `charset-plist`: what E8 works out — its
    /// name, dimension, code space, ISO 2022 final byte and whether it
    /// holds ASCII — and what Emacs says of its own charsets, its
    /// docstring, names, `emacs-mule` id and unification map, in Emacs's
    /// order, with what `set-charset-plist` put replacing or following them.
    pub fn charset_plist(&self, name: &str) -> Option<Plist> {
        use crate::variables::Value;
        let set = find(name)?;
        let num = |n: u32| Value::Number(n as f64);
        let str = |s: &str| Value::Str(s.to_string());
        let space: Vec<Value> = set.map.code_space().into_iter().flat_map(|(lo, hi)| [num(lo), num(hi)]).collect();
        let ascii = encode_char('a', set.name) == Some(0x61);
        let emacs = EMACS_CHARSETS.iter().find(|(n, ..)| *n == set.name);
        let mut plist = vec![(":name".to_string(), str(set.name))];
        if let Some((_, doc, short, long, ..)) = emacs {
            plist.push((":docstring".to_string(), str(doc)));
            plist.push((":short-name".to_string(), str(short)));
            plist.push((":long-name".to_string(), str(long)));
        }
        if let Some(final_byte) = iso_final(set.name) {
            plist.push((":iso-final-char".to_string(), num(final_byte as u32)));
        }
        if let Some((.., Some(id), _)) = emacs {
            plist.push((":emacs-mule-id".to_string(), num(*id)));
        }
        plist.push((":code-space".to_string(), Value::List(space)));
        if let Some((.., Some(map))) = emacs {
            plist.push((":unify-map".to_string(), str(map)));
        }
        plist.push((":dimension".to_string(), num(set.map.dimension())));
        plist.push((":ascii-compatible-p".to_string(), Value::Bool(ascii)));
        for (key, value) in self.plists.iter().find(|(n, _)| *n == set.name).map(|(_, v)| v.clone()).unwrap_or_default() {
            match plist.iter_mut().find(|(k, _)| *k == key) {
                Some((_, v)) => *v = value,
                None => plist.push((key, value)),
            }
        }
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
    CHARSETS.iter().position(|c| c.name == name).or_else(|| DEFINED.with(|d| d.borrow().iter().position(|c| c.name == name)).map(|i| CHARSETS.len() + i))
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
        Map::Defined(d) => {
            let code = match &d.how {
                How::Offset(offset) => n.checked_sub(*offset).map(|k| k + d.min_code),
                How::Subset { parent, min, max, offset } => encode_char(c, parent).filter(|p| (min..=max).contains(&p)).map(|p| p + offset),
                How::Superset(list) => list.iter().find_map(|(name, offset)| encode_char(c, name).map(|p| p + offset)),
                How::Unmapped => None,
            }?;
            (d.min_code..=d.max_code).contains(&code).then_some(code)
        }
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
        Map::Defined(d) => {
            if !(d.min_code..=d.max_code).contains(&code) {
                return None;
            }
            match &d.how {
                How::Offset(offset) => char::from_u32(offset + (code - d.min_code)),
                How::Subset { parent, min, max, offset } => code.checked_sub(*offset).filter(|p| (min..=max).contains(&p)).and_then(|p| decode_char(parent, p)),
                How::Superset(list) => list.iter().find_map(|(name, offset)| code.checked_sub(*offset).and_then(|p| decode_char(name, p))),
                How::Unmapped => None,
            }
        }
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
