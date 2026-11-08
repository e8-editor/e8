//! Coding systems: how bytes become text and back, as Emacs's coding.c and
//! the coding systems mule-conf.el defines.
//!
//! A coding system is a way of writing characters as bytes (UTF-8, UTF-16,
//! Latin-1 and the other ISO 8859 sets, the Windows code pages, Shift_JIS,
//! EUC, ISO-2022, GBK, Big5) and a way of ending lines, Unix, DOS or Mac, or
//! undecided, to be found from the text. The buffer itself always ends lines
//! with `\n`. Names and aliases, mnemonics, default characters and what is
//! detected are Emacs 30's. The multibyte tables are `encoding_rs`'s, which
//! are the WHATWG Encoding Standard's; where Emacs maps a character
//! differently, the difference is mended here.
//!
//! Bytes that are not text in the coding decode to raw-byte characters, as
//! Emacs's eight-bit charset does, so they are written back as they were.
//! Emacs's raw bytes are characters beyond Unicode; E8's are the last 128
//! code points, U+10FF80 to U+10FFFF, which Unicode leaves for private use.

use std::sync::OnceLock;

use encoding_rs::Encoding;

/// How lines end in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eol {
    Unix,
    Dos,
    Mac,
}

impl Eol {
    /// As Emacs numbers them in `coding-system-eol-type`.
    pub fn number(self) -> u8 {
        match self {
            Eol::Unix => 0,
            Eol::Dos => 1,
            Eol::Mac => 2,
        }
    }

    pub fn from_number(n: u8) -> Option<Eol> {
        Some(match n {
            0 => Eol::Unix,
            1 => Eol::Dos,
            2 => Eol::Mac,
            _ => return None,
        })
    }

    fn suffix(self) -> &'static str {
        match self {
            Eol::Unix => "unix",
            Eol::Dos => "dos",
            Eol::Mac => "mac",
        }
    }
}

/// Where the first raw-byte character is: byte 0x80's.
const RAW_BYTE_BASE: u32 = 0x10FF00;

/// The character standing for a byte that is not text, as Emacs's
/// `unibyte-char-to-multibyte` gives an eight-bit character for it. Bytes
/// below 0x80 are ASCII, and stand for themselves.
pub fn raw_byte_char(byte: u8) -> char {
    if byte < 0x80 {
        byte as char
    } else {
        char::from_u32(RAW_BYTE_BASE + byte as u32).expect("in Unicode's range")
    }
}

/// The byte a raw-byte character stands for, as Emacs's `char-to-byte`
/// (`multibyte-char-to-unibyte`) gives it.
pub fn char_raw_byte(c: char) -> Option<u8> {
    let n = c as u32;
    (RAW_BYTE_BASE + 0x80..=RAW_BYTE_BASE + 0xFF).contains(&n).then(|| (n - RAW_BYTE_BASE) as u8)
}

/// Bytes, as code that holds them in a string holds them: a character for
/// each, from U+0000 to U+00FF, as Emacs's unibyte strings print. A raw-byte
/// character stands for its byte too.
pub fn bytes_of_string(s: &str) -> Option<Vec<u8>> {
    s.chars().map(|c| if (c as u32) < 0x100 { Some(c as u8) } else { char_raw_byte(c) }).collect()
}

/// Bytes as a string of characters U+0000 to U+00FF, as `bytes_of_string` reads it.
pub fn string_of_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// Whether a byte order mark is written, read, or only looked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Bom {
    No,
    /// Written and expected, as `utf-8-with-signature` does.
    Yes,
    /// Taken away if there, and written when encoding for UTF-16 alone.
    Detect,
}

/// How a multibyte coding differs from the WHATWG table it is built on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Variant {
    /// As the table has it.
    Plain,
    /// Microsoft's Shift_JIS, code page 932, as the table has it: fullwidth
    /// forms where JIS X 0208 has others, which Emacs's Shift_JIS, EUC-JP
    /// and ISO-2022-JP use.
    Cp932,
    /// Only the 94×94 characters an EUC coding has, bytes A1 to FE, as GB 2312
    /// and KS C 5601 have them, not the extensions of GBK and code page 949.
    Euc94,
}

/// How a coding system writes characters as bytes.
#[derive(Clone, Copy, Debug)]
enum Kind {
    /// Not decided yet: found from the bytes when decoding, UTF-8 when
    /// encoding text that is not ASCII, as Emacs's preferred coding.
    Undecided,
    Utf8(Bom),
    Utf16 { big_endian: bool, bom: Bom },
    Ascii,
    Latin1,
    /// One byte for each character, from a table, with bytes 80 to 9F the
    /// C1 controls where `c1` says, as ISO 8859 has them and the Windows
    /// code page the table is has not.
    Single(&'static Encoding, bool),
    Multi(&'static Encoding, Variant),
    /// ISO 2022 with 7 bits, escape sequences choosing each character set,
    /// as Emacs's `iso-2022-7bit`.
    Iso2022Seven,
    /// Bytes as they are, text as the bytes Emacs keeps it in.
    RawText,
}

/// A coding system without its line ends, as Emacs's base coding systems.
#[derive(Debug)]
pub struct System {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    /// What the mode line shows for it.
    pub mnemonic: char,
    /// As `coding-system-type` gives it.
    pub coding_type: &'static str,
    /// As `(coding-system-get CODING :mime-charset)` gives it.
    pub mime_charset: Option<&'static str>,
    kind: Kind,
    /// Whether its line ends are fixed, as `no-conversion`'s are: it has no
    /// `-unix`, `-dos` and `-mac` forms.
    fixed_eol: bool,
}

macro_rules! system {
    ($name:literal, [$($alias:literal),*], $mnemonic:literal, $type:literal, $mime:expr, $kind:expr) => {
        System { name: $name, aliases: &[$($alias),*], mnemonic: $mnemonic, coding_type: $type, mime_charset: $mime, kind: $kind, fixed_eol: false }
    };
}

use encoding_rs as e;

/// The coding systems, in the order `coding-system-list` gives them.
static SYSTEMS: &[System] = &[
    system!("undecided", [], '-', "undecided", None, Kind::Undecided),
    system!("prefer-utf-8", [], '-', "undecided", None, Kind::Undecided),
    system!("utf-8", ["mule-utf-8", "cp65001"], 'U', "utf-8", Some("utf-8"), Kind::Utf8(Bom::No)),
    system!("utf-8-with-signature", [], 'U', "utf-8", None, Kind::Utf8(Bom::Yes)),
    system!("utf-8-auto", [], 'U', "utf-8", None, Kind::Utf8(Bom::Detect)),
    system!("utf-8-emacs", [], 'U', "utf-8", None, Kind::Utf8(Bom::No)),
    system!("utf-16", [], 'U', "utf-16", Some("utf-16"), Kind::Utf16 { big_endian: true, bom: Bom::Detect }),
    system!("utf-16le", [], 'U', "utf-16", Some("utf-16le"), Kind::Utf16 { big_endian: false, bom: Bom::No }),
    system!("utf-16be", [], 'U', "utf-16", Some("utf-16be"), Kind::Utf16 { big_endian: true, bom: Bom::No }),
    system!("utf-16le-with-signature", ["utf-16-le"], 'U', "utf-16", Some("utf-16"), Kind::Utf16 { big_endian: false, bom: Bom::Yes }),
    system!("utf-16be-with-signature", ["utf-16-be"], 'U', "utf-16", Some("utf-16"), Kind::Utf16 { big_endian: true, bom: Bom::Yes }),
    system!("us-ascii", ["iso-safe", "ascii"], '-', "charset", Some("us-ascii"), Kind::Ascii),
    system!("iso-latin-1", ["iso-8859-1", "latin-1"], '1', "charset", Some("iso-8859-1"), Kind::Latin1),
    system!("iso-latin-2", ["iso-8859-2", "latin-2"], '2', "charset", Some("iso-8859-2"), Kind::Single(e::ISO_8859_2, true)),
    system!("iso-latin-3", ["iso-8859-3", "latin-3"], '3', "charset", Some("iso-8859-3"), Kind::Single(e::ISO_8859_3, true)),
    system!("iso-latin-4", ["iso-8859-4", "latin-4"], '4', "charset", Some("iso-8859-4"), Kind::Single(e::ISO_8859_4, true)),
    system!("cyrillic-iso-8bit", ["iso-8859-5"], '5', "charset", Some("iso-8859-5"), Kind::Single(e::ISO_8859_5, true)),
    system!("greek-iso-8bit", ["iso-8859-7"], '7', "charset", Some("iso-8859-7"), Kind::Single(e::ISO_8859_7, true)),
    system!("hebrew-iso-8bit", ["iso-8859-8", "iso-8859-8-e", "iso-8859-8-i"], '8', "charset", Some("iso-8859-8"), Kind::Single(e::ISO_8859_8, true)),
    system!("iso-latin-5", ["iso-8859-9", "latin-5"], '9', "charset", Some("iso-8859-9"), Kind::Single(e::WINDOWS_1254, true)),
    system!("iso-latin-6", ["iso-8859-10", "latin-6"], '9', "charset", Some("iso-8859-10"), Kind::Single(e::ISO_8859_10, true)),
    system!("thai-tis620", ["th-tis620", "tis620", "tis-620"], 'T', "charset", None, Kind::Single(e::WINDOWS_874, true)),
    system!("iso-8859-11", [], '*', "charset", Some("iso-8859-11"), Kind::Single(e::WINDOWS_874, true)),
    system!("iso-latin-7", ["iso-8859-13", "latin-7"], '9', "charset", Some("iso-8859-13"), Kind::Single(e::ISO_8859_13, true)),
    system!("iso-latin-8", ["iso-8859-14", "latin-8"], 'W', "charset", Some("iso-8859-14"), Kind::Single(e::ISO_8859_14, true)),
    system!("iso-latin-9", ["iso-8859-15", "latin-9", "latin-0"], '0', "charset", Some("iso-8859-15"), Kind::Single(e::ISO_8859_15, true)),
    system!("iso-latin-10", ["iso-8859-16", "latin-10"], '*', "charset", Some("iso-8859-16"), Kind::Single(e::ISO_8859_16, true)),
    system!("windows-1250", ["cp1250"], '*', "charset", Some("windows-1250"), Kind::Single(e::WINDOWS_1250, false)),
    system!("windows-1251", ["cp1251"], 'b', "charset", Some("windows-1251"), Kind::Single(e::WINDOWS_1251, false)),
    system!("windows-1252", ["cp1252"], '*', "charset", Some("windows-1252"), Kind::Single(e::WINDOWS_1252, false)),
    system!("windows-1253", ["cp1253"], 'g', "charset", Some("windows-1253"), Kind::Single(e::WINDOWS_1253, false)),
    system!("windows-1254", ["cp1254"], '*', "charset", Some("windows-1254"), Kind::Single(e::WINDOWS_1254, false)),
    system!("windows-1255", ["cp1255"], 'h', "charset", Some("windows-1255"), Kind::Single(e::WINDOWS_1255, false)),
    system!("windows-1256", ["cp1256"], 'A', "charset", Some("windows-1256"), Kind::Single(e::WINDOWS_1256, false)),
    system!("windows-1257", ["cp1257"], '*', "charset", Some("windows-1257"), Kind::Single(e::WINDOWS_1257, false)),
    system!("windows-1258", ["cp1258"], '*', "charset", Some("windows-1258"), Kind::Single(e::WINDOWS_1258, false)),
    system!("cp874", ["ibm874"], 'D', "charset", Some("cp874"), Kind::Single(e::WINDOWS_874, false)),
    system!("cp866", [], '*', "charset", Some("cp866"), Kind::Single(e::IBM866, false)),
    system!("cyrillic-koi8", ["koi8-r", "koi8", "cp878"], 'R', "charset", Some("koi8-r"), Kind::Single(e::KOI8_R, false)),
    system!("koi8-u", [], 'У', "charset", Some("koi8-u"), Kind::Single(e::KOI8_U, false)),
    system!("mac-roman", ["macintosh"], 'M', "charset", Some("macintosh"), Kind::Single(e::MACINTOSH, false)),
    system!("japanese-shift-jis", ["shift_jis", "sjis"], 'S', "shift-jis", Some("shift_jis"), Kind::Multi(e::SHIFT_JIS, Variant::Plain)),
    system!("japanese-cp932", ["cp932"], 'S', "charset", None, Kind::Multi(e::SHIFT_JIS, Variant::Cp932)),
    system!("japanese-iso-8bit", ["euc-japan-1990", "euc-japan", "euc-jp"], 'E', "iso-2022", Some("euc-jp"), Kind::Multi(e::EUC_JP, Variant::Plain)),
    system!("iso-2022-jp", ["junet"], 'J', "iso-2022", Some("iso-2022-jp"), Kind::Multi(e::ISO_2022_JP, Variant::Plain)),
    system!("iso-2022-7bit", [], 'J', "iso-2022", None, Kind::Iso2022Seven),
    system!("chinese-iso-8bit", ["cn-gb-2312", "euc-china", "euc-cn", "cn-gb", "gb2312"], 'c', "iso-2022", Some("gb2312"), Kind::Multi(e::GBK, Variant::Euc94)),
    system!("chinese-gbk", ["gbk", "cp936", "windows-936"], 'c', "charset", Some("gbk"), Kind::Multi(e::GBK, Variant::Plain)),
    system!("chinese-gb18030", ["gb18030"], 'c', "charset", Some("gb18030"), Kind::Multi(e::GB18030, Variant::Plain)),
    system!("chinese-big5", ["big5", "cn-big5", "cp950"], 'B', "big5", Some("big5"), Kind::Multi(e::BIG5, Variant::Plain)),
    system!("chinese-big5-hkscs", ["big5-hkscs", "cn-big5-hkscs"], 'B', "charset", Some("big5-hkscs"), Kind::Multi(e::BIG5, Variant::Plain)),
    system!("korean-iso-8bit", ["euc-kr", "euc-korea", "ks_c_5601-1987"], 'K', "iso-2022", Some("euc-kr"), Kind::Multi(e::EUC_KR, Variant::Euc94)),
    system!("korean-cp949", ["cp949"], 'K', "charset", None, Kind::Multi(e::EUC_KR, Variant::Plain)),
    system!("raw-text", [], 't', "raw-text", None, Kind::RawText),
    System { name: "no-conversion", aliases: &["binary"], mnemonic: '=', coding_type: "raw-text", mime_charset: None, kind: Kind::RawText, fixed_eol: true },
];

/// A coding system with its line ends, as Emacs names them: `utf-8-unix`,
/// `iso-latin-1-dos`, or `undecided`, whose line ends are found from the text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Coding {
    system: usize,
    /// `None` if not decided, as for `utf-8` without `-unix`.
    pub eol: Option<Eol>,
}

impl Default for Coding {
    /// What a new file is written with: `undecided-unix`.
    fn default() -> Coding {
        Coding { system: 0, eol: Some(Eol::Unix) }
    }
}

/// An error a coding system name gives, as Emacs's `coding-system-error`.
#[derive(Debug, PartialEq, Eq)]
pub struct UnknownCoding(pub String);

const UTF8_SIGNATURE: &[u8] = b"\xEF\xBB\xBF";

impl Coding {
    /// The coding system a name names, with or without its line ends, by
    /// any of its aliases, as `check-coding-system` accepts it.
    pub fn parse(name: &str) -> Option<Coding> {
        let find = |base: &str| SYSTEMS.iter().position(|s| s.name == base || s.aliases.contains(&base));
        if let Some(system) = find(name) {
            let eol = SYSTEMS[system].fixed_eol.then_some(Eol::Unix);
            return Some(Coding { system, eol });
        }
        let (base, suffix) = name.rsplit_once('-')?;
        let eol = match suffix {
            "unix" => Eol::Unix,
            "dos" => Eol::Dos,
            "mac" => Eol::Mac,
            _ => return None,
        };
        let system = find(base)?;
        (!SYSTEMS[system].fixed_eol).then_some(Coding { system, eol: Some(eol) })
    }

    /// The coding system a name names, or Emacs's error for it.
    pub fn check(name: &str) -> std::result::Result<Coding, UnknownCoding> {
        Coding::parse(name).ok_or_else(|| UnknownCoding(name.to_string()))
    }

    /// A coding system by its base's name, which must be one of E8's.
    pub fn named(name: &str) -> Coding {
        Coding::parse(name).unwrap_or_else(|| panic!("no coding system {name}"))
    }

    pub fn system(&self) -> &'static System {
        &SYSTEMS[self.system]
    }

    /// The name Emacs gives this coding system, as `buffer-file-coding-system` shows it.
    pub fn name(&self) -> String {
        let base = self.system().name;
        match self.eol {
            Some(eol) if !self.system().fixed_eol => format!("{base}-{}", eol.suffix()),
            _ => base.to_string(),
        }
    }

    /// Every base coding system's name, then each alias, for completing them.
    pub fn names() -> impl Iterator<Item = &'static str> {
        SYSTEMS.iter().map(|s| s.name).chain(SYSTEMS.iter().flat_map(|s| s.aliases.iter().copied()))
    }

    /// The base coding systems, as `(coding-system-list t)`.
    pub fn base_systems() -> impl Iterator<Item = Coding> {
        (0..SYSTEMS.len()).map(|system| Coding { system, eol: None })
    }

    /// This coding system with other line ends, or undecided ones, as
    /// `coding-system-change-eol-conversion`.
    pub fn with_eol(self, eol: Option<Eol>) -> Coding {
        if self.system().fixed_eol { self } else { Coding { eol, ..self } }
    }

    /// The text conversion of `text` with these line ends, as
    /// `coding-system-change-text-conversion`.
    pub fn with_text(self, text: Coding) -> Coding {
        text.with_eol(self.eol.or(text.eol))
    }

    /// What the mode line shows for it, as Emacs's `mode-line-mule-info`:
    /// a letter for the charset and a sign for the line ends.
    pub fn mnemonic(&self) -> String {
        let eol = match self.eol {
            Some(Eol::Dos) => '\\',
            Some(Eol::Mac) => '/',
            Some(Eol::Unix) | None => ':',
        };
        format!("{}{eol}", self.system().mnemonic)
    }

    /// Whether this coding can write `c`, as `find-coding-systems-region` decides.
    pub fn can_encode(&self, c: char) -> bool {
        if char_raw_byte(c).is_some() {
            return true;
        }
        match self.system().kind {
            Kind::Undecided | Kind::Utf8(_) | Kind::Utf16 { .. } | Kind::RawText => true,
            Kind::Ascii => c.is_ascii(),
            Kind::Latin1 => (c as u32) < 0x100,
            Kind::Single(table, c1) => c.is_ascii() || single_encode(table, c1, c).is_some(),
            Kind::Multi(encoding, variant) => c.is_ascii() || multi_encode_char(encoding, variant, c).is_some(),
            Kind::Iso2022Seven => c.is_ascii() || iso2022_designation(c).is_some(),
        }
    }

    /// The character Emacs writes for one this coding cannot hold, its
    /// `:default-char`: a space, or `?` for ASCII.
    fn default_char(&self) -> u8 {
        if matches!(self.system().kind, Kind::Ascii) { b'?' } else { b' ' }
    }

    /// Whether the coding is not decided yet, as `undecided` is.
    pub fn is_undecided(&self) -> bool {
        matches!(self.system().kind, Kind::Undecided)
    }

    /// Decodes bytes, finding the line ends if they are not decided, as
    /// Emacs's `decode-coding-string`. An undecided coding is first found
    /// from the bytes. Returns the text and the coding used, decided.
    pub fn decode(&self, bytes: &[u8]) -> (String, Coding) {
        let mut coding = *self;
        if matches!(self.system().kind, Kind::Undecided) {
            coding = detect(bytes)[0].with_eol(self.eol);
        }
        coding.decode_as(bytes)
    }

    /// Decodes bytes in this coding, which is decided unless they are ASCII.
    fn decode_as(&self, bytes: &[u8]) -> (String, Coding) {
        let coding = *self;
        let text = match coding.system().kind {
            // Still undecided only for ASCII.
            Kind::Undecided => decode_utf8(bytes),
            Kind::Utf8(bom) => {
                let bytes = if bom != Bom::No { bytes.strip_prefix(UTF8_SIGNATURE).unwrap_or(bytes) } else { bytes };
                decode_utf8(bytes)
            }
            Kind::Utf16 { big_endian, bom } => decode_utf16(bytes, big_endian, bom),
            Kind::Ascii => bytes.iter().map(|&b| raw_byte_char(b)).collect(),
            Kind::Latin1 => bytes.iter().map(|&b| b as char).collect(),
            Kind::Single(table, c1) => {
                let decoded = single_table(table, c1);
                bytes.iter().map(|&b| decoded[b as usize].unwrap_or_else(|| raw_byte_char(b))).collect()
            }
            Kind::Multi(encoding, variant) => decode_multi(encoding, variant, bytes),
            Kind::Iso2022Seven => decode_iso2022_seven(bytes),
            Kind::RawText => bytes.iter().map(|&b| raw_byte_char(b)).collect(),
        };
        if coding.system().fixed_eol {
            return (text, coding);
        }
        let eol = coding.eol.unwrap_or_else(|| detect_eol(&text));
        let text = match eol {
            Eol::Unix => text,
            Eol::Dos => text.replace("\r\n", "\n"),
            Eol::Mac => text.replace('\r', "\n"),
        };
        (text, coding.with_eol(Some(eol)))
    }

    /// Encodes text, as Emacs's `encode-coding-string`: characters the
    /// coding cannot hold become its default character, and an undecided
    /// coding writes UTF-8 if the text is not ASCII. Returns the bytes and
    /// the coding used.
    pub fn encode_lossy(&self, text: &str) -> (Vec<u8>, Coding) {
        self.encode_text(text, false).expect("lossy encoding always encodes")
    }

    /// Encodes text as [`Coding::encode_lossy`] does, or with `strict`
    /// gives `None` as soon as a character the coding cannot hold comes,
    /// in the same pass.
    fn encode_text(&self, text: &str, strict: bool) -> Option<(Vec<u8>, Coding)> {
        let mut coding = *self;
        if matches!(self.system().kind, Kind::Undecided) {
            let base = if text.chars().all(|c| c.is_ascii() || char_raw_byte(c).is_some()) { self.system } else { 2 };
            coding = Coding { system: base, eol: self.eol };
        }
        let text = match (coding.system().fixed_eol, coding.eol) {
            (false, Some(Eol::Dos)) => text.replace('\n', "\r\n").into(),
            (false, Some(Eol::Mac)) => text.replace('\n', "\r").into(),
            _ => std::borrow::Cow::Borrowed(text),
        };
        let default = coding.default_char();
        let mut out = Vec::with_capacity(text.len());
        // Each character the coding holds as its byte, else as a raw byte,
        // else the default, or, when strict, the end of trying.
        let bytewise = |out: &mut Vec<u8>, byte: &dyn Fn(char) -> Option<u8>| {
            for c in text.chars() {
                match byte(c).or_else(|| char_raw_byte(c)) {
                    Some(b) => out.push(b),
                    None if strict => return false,
                    None => out.push(default),
                }
            }
            true
        };
        let encoded = match coding.system().kind {
            Kind::Undecided | Kind::Utf8(Bom::No | Bom::Detect) | Kind::RawText => {
                encode_utf8(&text, &mut out);
                true
            }
            Kind::Utf8(Bom::Yes) => {
                out.extend_from_slice(UTF8_SIGNATURE);
                encode_utf8(&text, &mut out);
                true
            }
            Kind::Utf16 { big_endian, bom } => {
                encode_utf16(&text, big_endian, bom != Bom::No, &mut out);
                true
            }
            Kind::Ascii => bytewise(&mut out, &|c| c.is_ascii().then_some(c as u8)),
            Kind::Latin1 => bytewise(&mut out, &|c| ((c as u32) < 0x100).then_some(c as u8)),
            Kind::Single(table, c1) => {
                // The table once for the text, not once a character.
                let table = single_coding(table, c1);
                bytewise(&mut out, &|c| if c.is_ascii() { Some(c as u8) } else { table.encode.get(&c).copied() })
            }
            Kind::Multi(encoding, variant) => encode_multi(encoding, variant, &text, default, strict, &mut out),
            Kind::Iso2022Seven if strict && !text.chars().all(|c| self.can_encode(c)) => false,
            Kind::Iso2022Seven => {
                encode_iso2022_seven(&text, default, &mut out);
                true
            }
        };
        encoded.then_some((out, coding))
    }

    /// Encodes text for saving. Text this coding cannot hold, such as a
    /// character beyond Latin-1, is saved as UTF-8 instead, and the coding
    /// that was used is returned with the bytes.
    pub fn encode(&self, text: &str) -> (Vec<u8>, Coding) {
        self.encode_text(text, true).unwrap_or_else(|| Coding { system: 2, eol: self.eol }.encode_lossy(text))
    }
}

thread_local! {
    /// The coding systems detection tries first, most preferred first, as
    /// `set-coding-system-priority` and `prefer-coding-system` make them.
    static PRIORITY: std::cell::RefCell<Vec<Coding>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Puts `codings` first among those detection prefers, in that order, as
/// Emacs's `set-coding-system-priority`: the others keep theirs after them.
pub fn set_priority(codings: &[Coding]) {
    PRIORITY.with(|p| {
        let mut p = p.borrow_mut();
        let named = |c: &Coding, d: &Coding| c.system().name == d.system().name;
        p.retain(|c| !codings.iter().any(|d| named(c, d)));
        for (i, c) in codings.iter().enumerate() {
            p.insert(i, c.with_eol(None));
        }
    });
}

/// The coding systems in the order detection tries them, as Emacs's
/// `coding-system-priority-list`: those preferred, then E8's own order.
pub fn priority_list() -> Vec<Coding> {
    let mut list = PRIORITY.with(|p| p.borrow().clone());
    for name in ["utf-8", "iso-2022-7bit", "iso-latin-1", "iso-2022-jp", "japanese-shift-jis", "undecided"] {
        let c = Coding::named(name).with_eol(None);
        if !list.iter().any(|d| d.system().name == name) {
            list.push(c);
        }
    }
    list
}

impl Coding {
    /// Whether bytes that are not all ASCII read in this coding without an
    /// error, so detection may choose it when it is preferred.
    fn fits(&self, bytes: &[u8]) -> bool {
        match self.system().kind {
            Kind::Utf8(_) => std::str::from_utf8(bytes.strip_prefix(UTF8_SIGNATURE).unwrap_or(bytes)).is_ok(),
            Kind::Latin1 => true,
            Kind::Single(encoding, _) | Kind::Multi(encoding, _) => decode_cleanly(encoding, bytes),
            Kind::Undecided | Kind::Utf16 { .. } | Kind::Ascii | Kind::Iso2022Seven | Kind::RawText => false,
        }
    }
}

/// The coding systems that could have written `bytes`, most likely first,
/// as Emacs's `detect-coding-string` lists them, those preferred first if
/// the bytes fit them. Line ends are not decided.
pub fn detect(bytes: &[u8]) -> Vec<Coding> {
    let base = |name: &str| Coding::named(name).with_eol(None);
    let scan = Scan::of(bytes);
    if scan.nul {
        return vec![Coding::named("no-conversion")];
    }
    if scan.ascii {
        if scan.esc && iso2022_escapes(bytes) {
            return vec![base("iso-2022-7bit"), base("iso-2022-jp")];
        }
        return vec![base("undecided")];
    }
    let mut found = Vec::new();
    if std::str::from_utf8(bytes).is_ok() {
        found.push(base("utf-8"));
    }
    found.push(base("iso-latin-1"));
    if !found.iter().any(|c| c.system().name == "utf-8") && decode_cleanly(e::SHIFT_JIS, bytes) {
        found.push(base("japanese-shift-jis"));
    }
    let preferred: Vec<Coding> = PRIORITY.with(|p| p.borrow().iter().filter(|c| c.fits(bytes)).copied().collect());
    if !preferred.is_empty() {
        found.retain(|c| !preferred.iter().any(|p| p.system().name == c.system().name));
        found.splice(0..0, preferred);
    }
    found
}

/// What detection looks for in bytes, found in one pass: whether they are
/// all ASCII, and whether they hold a NUL, which makes them binary, or an
/// escape, which may start ISO 2022.
struct Scan {
    ascii: bool,
    nul: bool,
    esc: bool,
}

impl Scan {
    fn of(bytes: &[u8]) -> Scan {
        // Eight bytes at a time: a byte is zero where subtracting one
        // borrows into its top bit, as the usual word-at-a-time search finds.
        const ONES: u64 = 0x0101_0101_0101_0101;
        const HIGHS: u64 = 0x8080_8080_8080_8080;
        const ESCS: u64 = 0x1B1B_1B1B_1B1B_1B1B;
        let zero = |x: u64| x.wrapping_sub(ONES) & !x & HIGHS;
        let (mut high, mut nul, mut esc) = (0, 0, 0);
        let (words, rest) = bytes.as_chunks::<8>();
        for word in words {
            let x = u64::from_le_bytes(*word);
            high |= x & HIGHS;
            nul |= zero(x);
            esc |= zero(x ^ ESCS);
        }
        Scan {
            ascii: high == 0 && rest.is_ascii(),
            nul: nul != 0 || rest.contains(&0),
            esc: esc != 0 || rest.contains(&0x1B),
        }
    }
}

/// Whether `bytes` decode in `encoding` without a malformed sequence.
fn decode_cleanly(encoding: &'static Encoding, bytes: &[u8]) -> bool {
    encoding.decode_without_bom_handling_and_without_replacement(bytes).is_some()
}

/// The coding a file's bytes say they are in, as Emacs's `set-auto-coding`
/// finds it: a byte order mark, as `auto-coding-regexp-alist` matches one,
/// then a `coding:` in the `-*-` line, which may be the second after `#!`,
/// or in a `Local Variables:` list at the end.
pub fn auto_coding(bytes: &[u8]) -> Option<Coding> {
    if bytes.starts_with(UTF8_SIGNATURE) {
        return Some(Coding::named("utf-8-with-signature").with_eol(None));
    }
    if bytes.starts_with(b"\xFF\xFE") {
        return Some(Coding::named("utf-16le-with-signature").with_eol(None));
    }
    if bytes.starts_with(b"\xFE\xFF") {
        return Some(Coding::named("utf-16be-with-signature").with_eol(None));
    }
    coding_cookie(bytes).or_else(|| local_variables_coding(bytes))
}

/// The coding a file's `-*-` line names, as `coding: latin-2`.
fn coding_cookie(bytes: &[u8]) -> Option<Coding> {
    let mut lines = bytes.split(|&b| b == b'\n');
    let first = lines.next()?;
    let line = if first.starts_with(b"#!") { lines.next()? } else { first };
    let text = String::from_utf8_lossy(line);
    let start = text.find("-*-")? + 3;
    let end = start + text[start..].find("-*-")?;
    let value = text[start..end].split(';').find_map(|part| {
        let (key, value) = part.split_once(':')?;
        (key.trim().eq_ignore_ascii_case("coding")).then(|| value.trim().to_string())
    })?;
    Coding::parse(&value)
}

/// The coding a `Local Variables:` list in a file's last 3000 bytes names.
fn local_variables_coding(bytes: &[u8]) -> Option<Coding> {
    let tail = &bytes[bytes.len().saturating_sub(3000)..];
    let text = String::from_utf8_lossy(tail);
    let start = text.rfind("Local Variables:")?;
    let rest = &text[start..];
    // Each line has the prefix and suffix the first line has around it.
    let line_start = text[..start].rfind('\n').map_or(0, |i| i + 1);
    let prefix = &text[line_start..start];
    for line in rest.lines().skip(1) {
        let line = line.strip_prefix(prefix).unwrap_or(line).trim();
        if line.starts_with("End:") {
            break;
        }
        if let Some(value) = line.strip_prefix("coding:") {
            return Coding::parse(value.split_whitespace().next()?);
        }
    }
    None
}

/// The coding to visit a file with, as `find-file` decides it: what the
/// file says it is in, else what its bytes look like.
pub fn visiting(bytes: &[u8]) -> Coding {
    auto_coding(bytes).unwrap_or_else(|| detect(bytes)[0])
}

/// Decodes a file's bytes in `coding` if given, as `coding-system-for-read`
/// gives one, else in the coding `visiting` finds, looking at them once.
pub fn decode_file(bytes: &[u8], coding: Option<Coding>) -> (String, Coding) {
    match coding {
        Some(coding) => coding.decode(bytes),
        None => {
            let found = visiting(bytes);
            if matches!(found.system().kind, Kind::Undecided) { found.decode_as(bytes) } else { found.decode(bytes) }
        }
    }
}

/// Lines end as DOS if every line feed follows a carriage return, as Mac
/// if there are carriage returns and no line feeds, and otherwise as Unix,
/// as Emacs decides, keeping stray carriage returns as text.
fn detect_eol(text: &str) -> Eol {
    let bytes = text.as_bytes();
    // Most files have no carriage return, which memchr finds out fast.
    if memchr::memchr(b'\r', bytes).is_none() {
        return Eol::Unix;
    }
    let mut lf = 0;
    let mut crlf = 0;
    let mut cr = false;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'\n' => {
                lf += 1;
                if i > 0 && bytes[i - 1] == b'\r' {
                    crlf += 1;
                }
            }
            b'\r' => cr = true,
            _ => {}
        }
    }
    if lf > 0 && crlf == lf {
        Eol::Dos
    } else if lf == 0 && cr {
        Eol::Mac
    } else {
        Eol::Unix
    }
}

// UTF-8 and UTF-16.

fn decode_utf8(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(bytes.len());
    for chunk in bytes.utf8_chunks() {
        out.push_str(chunk.valid());
        out.extend(chunk.invalid().iter().map(|&b| raw_byte_char(b)));
    }
    out
}

fn encode_utf8(text: &str, out: &mut Vec<u8>) {
    if text.chars().all(|c| char_raw_byte(c).is_none()) {
        out.extend_from_slice(text.as_bytes());
        return;
    }
    let mut buf = [0; 4];
    for c in text.chars() {
        match char_raw_byte(c) {
            Some(b) => out.push(b),
            None => out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes()),
        }
    }
}

fn decode_utf16(bytes: &[u8], big_endian: bool, bom: Bom) -> String {
    let (mut bytes, mut big_endian) = (bytes, big_endian);
    if bom != Bom::No {
        if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
            (bytes, big_endian) = (rest, true);
        } else if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
            (bytes, big_endian) = (rest, false);
        }
    }
    let units = bytes.as_chunks::<2>().0.iter().map(|&p| if big_endian { u16::from_be_bytes(p) } else { u16::from_le_bytes(p) });
    let mut out: String = char::decode_utf16(units).map(|r| r.unwrap_or('\u{FFFD}')).collect();
    if bytes.len() % 2 == 1 {
        out.push(raw_byte_char(bytes[bytes.len() - 1]));
    }
    out
}

fn encode_utf16(text: &str, big_endian: bool, bom: bool, out: &mut Vec<u8>) {
    let unit = |u: u16, out: &mut Vec<u8>| out.extend_from_slice(&if big_endian { u.to_be_bytes() } else { u.to_le_bytes() });
    if bom {
        unit(0xFEFF, out);
    }
    let mut buf = [0; 2];
    for c in text.chars() {
        for &u in c.encode_utf16(&mut buf).iter() {
            unit(u, out);
        }
    }
}

// Single-byte codings, from tables made once from encoding_rs's.

type SingleTable = [Option<char>; 256];

/// A single-byte coding's table both ways: each byte's character, and
/// each character's byte, the lowest where two bytes read as one.
struct SingleCoding {
    decode: SingleTable,
    encode: std::collections::HashMap<char, u8>,
}

/// The tables made so far, by encoding and whether 80 to 9F are C1 controls.
type SingleTables = std::sync::Mutex<Vec<(&'static str, bool, &'static SingleCoding)>>;

fn single_table(encoding: &'static Encoding, c1: bool) -> &'static SingleTable {
    &single_coding(encoding, c1).decode
}

fn single_coding(encoding: &'static Encoding, c1: bool) -> &'static SingleCoding {
    static TABLES: OnceLock<SingleTables> = OnceLock::new();
    let tables = TABLES.get_or_init(Default::default);
    let mut tables = tables.lock().expect("not poisoned");
    if let Some((_, _, table)) = tables.iter().find(|(n, c, _)| *n == encoding.name() && *c == c1) {
        return table;
    }
    let mut table: SingleTable = [None; 256];
    for (b, entry) in table.iter_mut().enumerate() {
        *entry = if c1 && (0x80..0xA0).contains(&b) {
            char::from_u32(b as u32)
        } else {
            encoding.decode_without_bom_handling_and_without_replacement(&[b as u8]).and_then(|s| s.chars().next())
        };
    }
    let mut encode = std::collections::HashMap::new();
    for (b, c) in table.iter().enumerate() {
        if let Some(c) = c {
            encode.entry(*c).or_insert(b as u8);
        }
    }
    let coding: &'static SingleCoding = Box::leak(Box::new(SingleCoding { decode: table, encode }));
    tables.push((encoding.name(), c1, coding));
    coding
}

fn single_encode(encoding: &'static Encoding, c1: bool, c: char) -> Option<u8> {
    single_coding(encoding, c1).encode.get(&c).copied()
}

// Multibyte codings, on encoding_rs.

/// Where JIS X 0208 maps a character otherwise than Microsoft's code page
/// 932 does, which the WHATWG tables follow: JIS's, then Microsoft's.
const CP932_FORMS: [(char, char); 6] =
    [('\u{301C}', '\u{FF5E}'), ('\u{2016}', '\u{2225}'), ('\u{2212}', '\u{FF0D}'), ('\u{00A2}', '\u{FFE0}'), ('\u{00A3}', '\u{FFE1}'), ('\u{00AC}', '\u{FFE2}')];

fn decode_multi(encoding: &'static Encoding, variant: Variant, bytes: &[u8]) -> String {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut out = String::with_capacity(bytes.len() * 2);
    let mut rest = bytes;
    loop {
        out.reserve(decoder.max_utf8_buffer_length_without_replacement(rest.len()).unwrap_or(rest.len() * 4) + 4);
        let (result, read) = decoder.decode_to_string_without_replacement(rest, &mut out, true);
        match result {
            encoding_rs::DecoderResult::InputEmpty => break,
            encoding_rs::DecoderResult::OutputFull => rest = &rest[read..],
            encoding_rs::DecoderResult::Malformed(bad, after) => {
                let end = read - after as usize;
                let start = end.saturating_sub(bad as usize);
                out.extend(rest[start..end].iter().map(|&b| raw_byte_char(b)));
                // What it read past the malformed bytes is read again.
                rest = &rest[end..];
                decoder = encoding.new_decoder_without_bom_handling();
            }
        }
    }
    if jis_forms(encoding, variant) {
        out.chars().map(|c| CP932_FORMS.iter().find(|(_, ms)| *ms == c).map_or(c, |(jis, _)| *jis)).collect()
    } else {
        out
    }
}

/// Whether a coding maps JIS X 0208 as JIS does, as Emacs's Japanese codings
/// but code page 932 do.
fn jis_forms(encoding: &'static Encoding, variant: Variant) -> bool {
    variant != Variant::Cp932 && (encoding == e::SHIFT_JIS || encoding == e::EUC_JP || encoding == e::ISO_2022_JP)
}

/// The bytes one character encodes to, if the coding has it.
fn multi_encode_char(encoding: &'static Encoding, variant: Variant, c: char) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(8);
    multi_encode_into(&mut encoding.new_encoder(), encoding, variant, c, &mut out).then_some(out)
}

/// Appends the bytes `c` encodes to with `encoder`, one of `encoding`'s
/// kept for a whole text, as the codings this is for keep no state between
/// characters; false, appending nothing, if the coding does not have it.
fn multi_encode_into(encoder: &mut encoding_rs::Encoder, encoding: &'static Encoding, variant: Variant, c: char, out: &mut Vec<u8>) -> bool {
    // The table takes Microsoft's forms, and for Shift_JIS reads yen and
    // overline as ASCII's backslash and tilde, as Emacs's JIS codings do not.
    let c = if jis_forms(encoding, variant) {
        if CP932_FORMS.iter().any(|(_, ms)| *ms == c) || c == '\u{A5}' || c == '\u{203E}' {
            return false;
        }
        CP932_FORMS.iter().find(|(jis, _)| *jis == c).map_or(c, |(_, ms)| *ms)
    } else if variant == Variant::Cp932 && CP932_FORMS.iter().any(|(jis, _)| *jis == c) {
        return false;
    } else {
        c
    };
    let mut buf = [0; 4];
    let before = out.len();
    out.reserve(8);
    let (result, _) = encoder.encode_from_utf8_to_vec_without_replacement(c.encode_utf8(&mut buf), out, false);
    let bytes = &out[before..];
    let fits = matches!(result, encoding_rs::EncoderResult::InputEmpty)
        && (variant != Variant::Euc94 || c.is_ascii() || (bytes.len() == 2 && bytes.iter().all(|b| (0xA1..=0xFE).contains(b))));
    if !fits {
        out.truncate(before);
    }
    fits
}

/// Encodes `text` in a multibyte coding; with `strict`, false as soon as
/// a character the coding cannot hold comes, rather than its default.
fn encode_multi(encoding: &'static Encoding, variant: Variant, text: &str, default: u8, strict: bool, out: &mut Vec<u8>) -> bool {
    if encoding == e::ISO_2022_JP {
        // Stateful: the encoder chooses the escape sequences, and a
        // character it cannot hold goes as the default character, in ASCII.
        let mut encoder = encoding.new_encoder();
        let (mut check, mut scratch) = (encoding.new_encoder(), Vec::new());
        let mut buf = [0; 4];
        for c in text.chars() {
            scratch.clear();
            let fits = multi_encode_into(&mut check, encoding, variant, c, &mut scratch);
            if strict && !fits && char_raw_byte(c).is_none() {
                return false;
            }
            let piece = if fits { c } else { default as char };
            out.reserve(16);
            let _ = encoder.encode_from_utf8_to_vec_without_replacement(piece.encode_utf8(&mut buf), out, false);
        }
        out.reserve(16);
        let _ = encoder.encode_from_utf8_to_vec_without_replacement("", out, true);
        return true;
    }
    let mut encoder = encoding.new_encoder();
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c as u8);
        } else if !multi_encode_into(&mut encoder, encoding, variant, c, out) {
            match char_raw_byte(c) {
                Some(b) => out.push(b),
                None if strict => return false,
                None => out.push(default),
            }
        }
    }
    true
}

// ISO 2022 in 7 bits, as Emacs's iso-2022-7bit writes it.

/// A character set ISO 2022 designates, and how it is read.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Iso2022Set {
    Ascii,
    /// JIS X 0201's katakana, ESC ( I.
    Katakana,
    /// A 96-character ISO 8859 set, ESC , and its final byte.
    Latin(u8),
    /// A 94×94 set, its final byte, and the EUC coding that holds it.
    Double(u8, &'static Encoding),
}

/// The ISO 8859 sets by their final bytes, in Emacs's charset priority.
const ISO8859_FINALS: [(u8, &str); 14] = [
    (b'A', "iso-latin-1"),
    (b'B', "iso-latin-2"),
    (b'C', "iso-latin-3"),
    (b'D', "iso-latin-4"),
    (b'L', "cyrillic-iso-8bit"),
    (b'F', "greek-iso-8bit"),
    (b'H', "hebrew-iso-8bit"),
    (b'M', "iso-latin-5"),
    (b'V', "iso-latin-6"),
    (b'T', "iso-8859-11"),
    (b'Y', "iso-latin-7"),
    (b'_', "iso-latin-8"),
    (b'b', "iso-latin-9"),
    (b'f', "iso-latin-10"),
];

/// The 94×94 sets, by final byte, in the order they are tried: Emacs's
/// charset priority, GB 2312 first, unless the text is Japanese, with kana,
/// or Korean, with Hangul. Emacs keeps the set each character was read in
/// as a `charset` text property, so a file written back keeps its sets;
/// E8 has no such property, and goes by the text.
fn double_sets(text: &str) -> [(u8, &'static Encoding); 3] {
    let (gb, jis, ksc) = ((b'A', e::GBK), (b'B', e::EUC_JP), (b'C', e::EUC_KR));
    let has = |range: std::ops::RangeInclusive<u32>| text.chars().any(|c| range.contains(&(c as u32)));
    if has(0x3040..=0x30FF) {
        [jis, gb, ksc]
    } else if has(0xAC00..=0xD7A3) {
        [ksc, gb, jis]
    } else {
        [gb, jis, ksc]
    }
}

/// The set ISO 2022 writes a character in, and its bytes there, the 94×94
/// sets tried in the order `sets` gives.
fn iso2022_designation_in(c: char, sets: &[(u8, &'static Encoding); 3]) -> Option<(Iso2022Set, Vec<u8>)> {
    if c.is_ascii() {
        return Some((Iso2022Set::Ascii, vec![c as u8]));
    }
    for (final_byte, name) in ISO8859_FINALS {
        if let Some(b) = Coding::named(name).single_byte(c)
            && b >= 0xA0
        {
            return Some((Iso2022Set::Latin(final_byte), vec![b - 0x80]));
        }
    }
    for &(final_byte, encoding) in sets {
        if let Some(bytes) = multi_encode_char(encoding, Variant::Euc94, c)
            && bytes.len() == 2
        {
            return Some((Iso2022Set::Double(final_byte, encoding), bytes.iter().map(|b| b & 0x7F).collect()));
        }
    }
    let n = c as u32;
    (0xFF61..=0xFF9F).contains(&n).then(|| (Iso2022Set::Katakana, vec![(n - 0xFF61 + 0x21) as u8]))
}

fn iso2022_designation(c: char) -> Option<(Iso2022Set, Vec<u8>)> {
    iso2022_designation_in(c, &double_sets(""))
}

impl Coding {
    /// The byte a single-byte coding writes `c` as.
    fn single_byte(&self, c: char) -> Option<u8> {
        match self.system().kind {
            Kind::Latin1 => ((c as u32) < 0x100).then_some(c as u8),
            Kind::Single(table, c1) => single_encode(table, c1, c),
            _ => None,
        }
    }
}

fn designate(set: Iso2022Set, out: &mut Vec<u8>) {
    match set {
        Iso2022Set::Ascii => out.extend_from_slice(b"\x1B(B"),
        Iso2022Set::Katakana => out.extend_from_slice(b"\x1B(I"),
        Iso2022Set::Latin(f) => out.extend_from_slice(&[0x1B, b',', f]),
        Iso2022Set::Double(f @ (b'A' | b'B'), _) => out.extend_from_slice(&[0x1B, b'$', f]),
        Iso2022Set::Double(f, _) => out.extend_from_slice(&[0x1B, b'$', b'(', f]),
    }
}

fn encode_iso2022_seven(text: &str, default: u8, out: &mut Vec<u8>) {
    let mut current = Iso2022Set::Ascii;
    let sets = double_sets(text);
    for c in text.chars() {
        let (set, bytes) = iso2022_designation_in(c, &sets).unwrap_or((Iso2022Set::Ascii, vec![char_raw_byte(c).unwrap_or(default)]));
        // Each line starts in ASCII, as Emacs resets the designation at a line's end.
        let set = if c == '\n' || c == '\r' { Iso2022Set::Ascii } else { set };
        if set != current {
            designate(set, out);
            current = set;
        }
        out.extend(bytes);
    }
    if current != Iso2022Set::Ascii {
        designate(Iso2022Set::Ascii, out);
    }
}

/// Whether ASCII bytes hold ISO 2022 escape sequences E8 reads.
fn iso2022_escapes(bytes: &[u8]) -> bool {
    bytes.windows(3).any(|w| w[0] == 0x1B && matches!((w[1], w[2]), (b'$', b'@' | b'A' | b'B' | b'(') | (b'(', b'I' | b'J') | (b',' | b'-', _)))
}

fn decode_iso2022_seven(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut set = Iso2022Set::Ascii;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1B {
            let next = |k: usize| bytes.get(i + k).copied();
            let designated = match (next(1), next(2), next(3)) {
                (Some(b'('), Some(b'B' | b'J'), _) => Some((Iso2022Set::Ascii, 3)),
                (Some(b'('), Some(b'I'), _) => Some((Iso2022Set::Katakana, 3)),
                (Some(b'$'), Some(b'@' | b'B'), _) => Some((Iso2022Set::Double(b'B', e::EUC_JP), 3)),
                (Some(b'$'), Some(b'A'), _) => Some((Iso2022Set::Double(b'A', e::GBK), 3)),
                (Some(b'$'), Some(b'('), Some(b'C')) => Some((Iso2022Set::Double(b'C', e::EUC_KR), 4)),
                (Some(b'$'), Some(b'('), Some(b'D')) => Some((Iso2022Set::Double(b'D', e::EUC_JP), 4)),
                (Some(b',' | b'-'), Some(f), _) if ISO8859_FINALS.iter().any(|(x, _)| *x == f) => Some((Iso2022Set::Latin(f), 3)),
                _ => None,
            };
            if let Some((new, len)) = designated {
                set = new;
                i += len;
                continue;
            }
        }
        if b == b'\n' || b == b'\r' || !(0x20..0x80).contains(&b) {
            out.push(if b >= 0x80 { raw_byte_char(b) } else { b as char });
            i += 1;
            continue;
        }
        match set {
            Iso2022Set::Ascii => {
                out.push(b as char);
                i += 1;
            }
            Iso2022Set::Katakana => {
                out.push(char::from_u32(0xFF61 + (b as u32).saturating_sub(0x21)).unwrap_or(b as char));
                i += 1;
            }
            Iso2022Set::Latin(f) => {
                let name = ISO8859_FINALS.iter().find(|(x, _)| *x == f).map(|(_, n)| *n).unwrap_or("iso-latin-1");
                out.push_str(&Coding::named(name).with_eol(Some(Eol::Unix)).decode(&[b | 0x80]).0);
                i += 1;
            }
            Iso2022Set::Double(f, encoding) => {
                let Some(&second) = bytes.get(i + 1) else {
                    out.push(b as char);
                    break;
                };
                let euc: Vec<u8> = if f == b'D' { vec![0x8F, b | 0x80, second | 0x80] } else { vec![b | 0x80, second | 0x80] };
                out.push_str(&decode_multi(encoding, Variant::Plain, &euc));
                i += 2;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visit(bytes: &[u8]) -> (String, Coding) {
        visiting(bytes).decode(bytes)
    }

    #[test]
    fn detects_and_round_trips() {
        for (bytes, name) in [
            (&b"plain\n"[..], "undecided-unix"),
            (b"caf\xC3\xA9\n", "utf-8-unix"),
            (b"caf\xE9\n", "iso-latin-1-unix"),
            (b"a\r\nb\r\n", "undecided-dos"),
            (b"a\rb\r", "undecided-mac"),
            (b"\xEF\xBB\xBFsigned\n", "utf-8-with-signature-unix"),
            (b"mixed\r\nends\n", "undecided-unix"),
            (b"\xFF\xFEx\0\n\0", "utf-16le-with-signature-unix"),
            (b"\x1B$B$\"\x1B(B\n", "iso-2022-7bit-unix"),
            (b"\0\x01\x02\n", "no-conversion"),
            (b"-*- coding: latin-2 -*-\n\xB1\n", "iso-latin-2-unix"),
        ] {
            let (text, coding) = visit(bytes);
            assert_eq!(coding.name(), name, "{bytes:?}");
            assert_eq!(coding.encode(&text).0, bytes, "{name}");
        }
        assert_eq!(visit(b"a\r\nb\r\n").0, "a\nb\n");
        assert_eq!(visit(b"caf\xE9").0, "café");
        assert_eq!(visit(b"\x1B$B$\"\x1B(B").0, "あ");
        assert_eq!(visit(b"#!/bin/sh\n# -*- mode: sh; coding: iso-8859-5 -*-\n\xB0\n").0.chars().nth(49), Some('А'));
        assert_eq!(visit(b"\xE9\nLocal Variables:\ncoding: windows-1252\nEnd:\n").1.name(), "windows-1252-unix");
    }

    #[test]
    fn encodes_as_emacs_does() {
        let enc = |text: &str, name: &str| Coding::named(name).encode_lossy(text).0;
        assert_eq!(enc("a€é", "iso-latin-1"), b"a \xE9");
        assert_eq!(enc("aあ", "us-ascii"), b"a?");
        assert_eq!(enc("aあ", "japanese-shift-jis"), b"a\x82\xA0");
        assert_eq!(enc("あ\nい", "iso-2022-jp"), b"\x1B$B$\"\x1B(B\n\x1B$B$$\x1B(B");
        assert_eq!(enc("x", "utf-16"), b"\xFE\xFF\0x");
        assert_eq!(enc("x", "utf-16le"), b"x\0");
        assert_eq!(enc("中文", "chinese-gbk"), b"\xD6\xD0\xCE\xC4");
        assert_eq!(enc("€", "windows-1252"), b"\x80");
        assert_eq!(enc("a\n", "utf-8-mac"), b"a\r");
        assert_eq!(enc("\u{1F600}", "utf-16be"), b"\xD8\x3D\xDE\x00");
        assert_eq!(enc("あ", "japanese-iso-8bit"), b"\xA4\xA2");
        assert_eq!(enc("한", "korean-iso-8bit"), b"\xC7\xD1");
        assert_eq!(enc("中", "chinese-big5"), b"\xA4\xA4");
        assert_eq!(enc("€", "gb18030"), b"\xA2\xE3");
        assert_eq!(enc("é", "raw-text"), b"\xC3\xA9");
        assert_eq!(enc("é\n", "undecided-dos"), b"\xC3\xA9\r\n");
        assert_eq!(enc("a한€", "chinese-big5"), b"a \xA3\xE1");
        assert_eq!(enc("é", "iso-2022-7bit"), b"\x1B,Ai\x1B(B");
        // Emacs writes kana alone in GB 2312's set, by its charset priority;
        // E8 writes Japanese text in JIS's, as it was most likely read.
        assert_eq!(enc("あ", "iso-2022-7bit"), b"\x1B$B$\"\x1B(B");
        assert_eq!(enc("中", "iso-2022-7bit"), b"\x1B$AVP\x1B(B");
        assert_eq!(enc("한", "iso-2022-7bit"), b"\x1B$(CGQ\x1B(B");
        assert_eq!(enc("Ω", "iso-2022-7bit"), b"\x1B,FY\x1B(B");
        assert_eq!(enc("〜～", "japanese-shift-jis"), b"\x81\x60 ");
        assert_eq!(enc("〜～", "japanese-cp932"), b" \x81\x60");
        assert_eq!(enc("\\¥", "japanese-shift-jis"), b"\\ ");
    }

    /// Saving encodes in one pass, falling back to UTF-8 when a character
    /// does not fit, and a large text in a single-byte or multibyte coding
    /// encodes quickly: the table is found once for the text, and one
    /// encoder serves it all.
    #[test]
    fn saving_encodes_in_one_pass_and_quickly() {
        let save = |text: &str, name: &str| {
            let (bytes, coding) = Coding::named(name).encode(text);
            (bytes, coding.name())
        };
        assert_eq!(save("aą", "iso-latin-2"), (b"a\xB1".to_vec(), "iso-latin-2".to_string()));
        assert_eq!(save("aあ", "iso-latin-2"), ("aあ".as_bytes().to_vec(), "utf-8".to_string()));
        assert_eq!(save("aあ", "japanese-shift-jis"), (b"a\x82\xA0".to_vec(), "japanese-shift-jis".to_string()));
        assert_eq!(save("a€", "japanese-shift-jis").1, "utf-8");
        assert_eq!(save("あ€", "iso-2022-jp").1, "utf-8");
        assert_eq!(save("é", "us-ascii").1, "utf-8");
        let started = crate::clock::Instant::now();
        let polish = "zażółć gęślą jaźń\n".repeat(50_000);
        assert_eq!(Coding::named("iso-latin-2").encode(&polish).1.name(), "iso-latin-2");
        let japanese = "日本語のテキスト\n".repeat(50_000);
        assert_eq!(Coding::named("japanese-shift-jis").encode(&japanese).1.name(), "japanese-shift-jis");
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "took {:?}", started.elapsed());
    }

    #[test]
    fn decodes_as_emacs_does() {
        let dec = |bytes: &[u8], name: &str| Coding::named(name).decode(bytes).0;
        assert_eq!(dec(b"caf\xE9", "utf-8"), format!("caf{}", raw_byte_char(0xE9)));
        assert_eq!(Coding::named("utf-8").encode_lossy(&dec(b"caf\xE9", "utf-8")).0, b"caf\xE9");
        assert_eq!(dec(b"a\r\nb\r\n", "utf-8"), "a\nb\n");
        assert_eq!(dec(b"a\r\nb", "utf-8-unix"), "a\r\nb");
        assert_eq!(dec(b"\x82\xA0", "japanese-shift-jis"), "あ");
        assert_eq!(dec(b"\x81\x60", "japanese-shift-jis"), "〜");
        assert_eq!(dec(b"\x81\x60", "japanese-cp932"), "～");
        assert_eq!(dec(b"\x81\x7C\x81\x91", "japanese-cp932"), "－￠");
        assert_eq!(dec(b"\x81\x7C\x81\x91", "japanese-shift-jis"), "−¢");
        assert_eq!(dec(b"\xA0", "japanese-shift-jis"), raw_byte_char(0xA0).to_string());
        assert_eq!(dec(b"\xFE\xFF\0x", "utf-16"), "x");
        assert_eq!(dec(b"\x80", "windows-1252"), "€");
        assert_eq!(dec(b"\x80", "iso-latin-1"), "\u{80}");
        assert_eq!(dec(b"\x80\xFD", "iso-latin-5"), "\u{80}ı");
        assert_eq!(dec(b"\xEF\xBB\xBFx", "utf-8"), "\u{FEFF}x");
        assert_eq!(dec(b"\xEF\xBB\xBFx", "utf-8-auto"), "x");
        assert_eq!(dec(b"\x1B$B$\"\x1B(Ba\x1B$A$\"\x1B(B\x1B$(C0!\x1B(B", "iso-2022-7bit"), "あaあ가");
        assert_eq!(dec(b"\x8E\xB1", "japanese-iso-8bit"), "ｱ");
        assert_eq!(dec(b"\x8F\xB0\xA1", "japanese-iso-8bit"), "丂");
    }

    #[test]
    fn names_parse_as_emacs_spells_them() {
        assert_eq!(Coding::named("utf-8-dos").name(), "utf-8-dos");
        assert_eq!(Coding::named("latin-1").with_eol(Some(Eol::Dos)).name(), "iso-latin-1-dos");
        assert_eq!(Coding::named("utf-8").name(), "utf-8");
        assert_eq!(Coding::named("utf-8").with_eol(Some(Eol::Mac)).mnemonic(), "U/");
        assert_eq!(Coding::named("binary").name(), "no-conversion");
        assert_eq!(Coding::named("sjis-dos").name(), "japanese-shift-jis-dos");
        assert!(Coding::parse("klingon").is_none());
        assert!(Coding::parse("no-conversion-dos").is_none());
    }
}
