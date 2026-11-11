//! Syntax tables, as Emacs's syntax.c: what each character is to the
//! commands that move over words, lists and strings and skip comments.
//!
//! A table gives each character a class, such as word, open paren or
//! string quote, and flags for comment delimiters two characters long, as
//! C's `/*` and `*/`. Tables are named and inherit from another, in the end
//! from `standard-syntax-table`; each buffer uses one, as its major mode
//! sets it. On these rest Emacs's scanners: `scan-lists` and `scan-sexps`
//! move over balanced expressions, `forward-comment` over comments, and
//! `parse-partial-sexp` says where in its parens, strings and comments a
//! position is.

use std::collections::HashMap;

use crate::buffer::Buffer;
use crate::error::{Error, Result};

/// A character's syntax class, as Emacs's `enum syntaxcode`, written as
/// `modify-syntax-entry` writes it: `" "`, `"."`, `"w"` and so on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Whitespace,
    Punct,
    Word,
    Symbol,
    Open,
    Close,
    /// An expression prefix, such as Lisp's quote.
    Quote,
    String,
    Math,
    Escape,
    CharQuote,
    Comment,
    EndComment,
    Inherit,
    CommentFence,
    StringFence,
}

impl Class {
    /// The classes in Emacs's order, as `enum syntaxcode` numbers them.
    pub const ALL: [Class; 16] = [
        Class::Whitespace,
        Class::Punct,
        Class::Word,
        Class::Symbol,
        Class::Open,
        Class::Close,
        Class::Quote,
        Class::String,
        Class::Math,
        Class::Escape,
        Class::CharQuote,
        Class::Comment,
        Class::EndComment,
        Class::Inherit,
        Class::CommentFence,
        Class::StringFence,
    ];

    pub(crate) fn from_char(c: char) -> Option<Class> {
        Some(match c {
            ' ' | '-' => Class::Whitespace,
            '.' => Class::Punct,
            'w' => Class::Word,
            '_' => Class::Symbol,
            '(' => Class::Open,
            ')' => Class::Close,
            '\'' => Class::Quote,
            '"' => Class::String,
            '$' => Class::Math,
            '\\' => Class::Escape,
            '/' => Class::CharQuote,
            '<' => Class::Comment,
            '>' => Class::EndComment,
            '@' => Class::Inherit,
            '!' => Class::CommentFence,
            '|' => Class::StringFence,
            _ => return None,
        })
    }

    /// The class's designator, as `char-syntax` returns it.
    pub fn designator(self) -> char {
        match self {
            Class::Whitespace => ' ',
            Class::Punct => '.',
            Class::Word => 'w',
            Class::Symbol => '_',
            Class::Open => '(',
            Class::Close => ')',
            Class::Quote => '\'',
            Class::String => '"',
            Class::Math => '$',
            Class::Escape => '\\',
            Class::CharQuote => '/',
            Class::Comment => '<',
            Class::EndComment => '>',
            Class::Inherit => '@',
            Class::CommentFence => '!',
            Class::StringFence => '|',
        }
    }
}

/// Flags of a syntax entry, as the digits and letters after its class.
pub mod flags {
    /// First character of a two-character comment start.
    pub const START1: u8 = 1;
    /// Second character of a two-character comment start.
    pub const START2: u8 = 2;
    /// First character of a two-character comment end.
    pub const END1: u8 = 4;
    /// Second character of a two-character comment end.
    pub const END2: u8 = 8;
    /// An expression prefix, skipped before a sexp.
    pub const PREFIX: u8 = 16;
    /// Comment style b.
    pub const STYLE_B: u8 = 32;
    /// Comments nest.
    pub const NESTED: u8 = 64;
    /// Comment style c.
    pub const STYLE_C: u8 = 128;
}

/// What a character is to a syntax table: its class, the character it
/// matches if it is a paren, and its flags.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Entry {
    pub class: Class,
    pub matching: Option<char>,
    pub flags: u8,
}

impl Entry {
    pub const fn new(class: Class) -> Entry {
        Entry { class, matching: None, flags: 0 }
    }

    fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }

    /// Parses an entry as `modify-syntax-entry` writes it: a class, then
    /// the matching character or a space, then flags, as ". 124b".
    pub fn parse(descriptor: &str) -> Result<Entry> {
        let mut chars = descriptor.chars();
        let class = chars
            .next()
            .and_then(Class::from_char)
            .ok_or_else(|| Error::new(format!("Invalid syntax description letter: {descriptor}")))?;
        let matching = chars.next().filter(|&c| c != ' ');
        let mut flags = 0;
        for c in chars {
            flags |= match c {
                '1' => flags::START1,
                '2' => flags::START2,
                '3' => flags::END1,
                '4' => flags::END2,
                'p' => flags::PREFIX,
                'b' => flags::STYLE_B,
                'n' => flags::NESTED,
                'c' => flags::STYLE_C,
                _ => 0,
            };
        }
        Ok(Entry { class, matching, flags })
    }

    /// The entry from Emacs's raw syntax descriptor, the cons
    /// `string-to-syntax` returns: the class's number in the low 8 bits, as
    /// Emacs's syntax_property reads it, the flags from bit 16, and the
    /// matching character.
    pub fn from_raw(code: u32, matching: Option<char>) -> Option<Entry> {
        let class = *Class::ALL.get((code & 0xff) as usize)?;
        Some(Entry { class, matching, flags: (code >> 16) as u8 })
    }

    /// The entry as Emacs's raw syntax descriptor's code, as `string-to-syntax` gives it.
    pub fn raw_code(&self) -> u32 {
        Class::ALL.iter().position(|c| *c == self.class).unwrap_or(0) as u32 | (u32::from(self.flags) << 16)
    }

    /// The entry a `syntax-table` text property gives: a descriptor such as
    /// ".", a raw descriptor as `string-to-syntax` returns, `[code, matching]`,
    /// or the name of a syntax table to look the character up in.
    pub fn from_property(value: &crate::Value, tables: &SyntaxTables, c: char) -> Option<Entry> {
        match value {
            crate::Value::Str(s) | crate::Value::Symbol(s) if tables.exists(s) => Some(tables.entry(s, c)),
            crate::Value::Str(s) => Entry::parse(s).ok(),
            crate::Value::List(items) => {
                let code = items.first()?.as_number().filter(|n| *n >= 0.0)?;
                // The matching character, as a string or a character code.
                let matching = items.get(1).and_then(|m| match m {
                    crate::Value::Number(n) => char::from_u32(*n as u32),
                    m => m.as_str().and_then(|m| m.chars().next()),
                });
                Entry::from_raw(code as u32, matching)
            }
            _ => None,
        }
    }

    /// The entry written back as a descriptor, as `modify-syntax-entry` takes it.
    pub fn descriptor(&self) -> String {
        let mut s = String::new();
        s.push(self.class.designator());
        s.push(self.matching.unwrap_or(' '));
        for (flag, c) in [
            (flags::START1, '1'),
            (flags::START2, '2'),
            (flags::END1, '3'),
            (flags::END2, '4'),
            (flags::PREFIX, 'p'),
            (flags::STYLE_B, 'b'),
            (flags::NESTED, 'n'),
            (flags::STYLE_C, 'c'),
        ] {
            if self.has(flag) {
                s.push(c);
            }
        }
        // Only the padding goes: whitespace's own class is a space.
        let trimmed = s[1..].trim_end().len();
        s.truncate(1 + trimmed);
        s
    }

    /// The comment style a character starting or ending a comment gives
    /// it: 0 for a, 1 for b, 2 for c, as Emacs's SYNTAX_FLAGS_COMMENT_STYLE.
    fn style(&self) -> u8 {
        u8::from(self.has(flags::STYLE_B)) | (u8::from(self.has(flags::STYLE_C)) << 1)
    }
}

/// A syntax table: entries of its own, and the table it inherits the rest from.
#[derive(Clone, Debug, Default)]
pub struct SyntaxTable {
    pub entries: HashMap<char, Entry>,
    pub parent: Option<String>,
}

pub const STANDARD: &str = "standard-syntax-table";

/// The standard syntax table's entry for a character, as Emacs's
/// init_syntax_once sets it: letters, digits, `$` and `%` are words, the
/// brackets are parens, `"` quotes strings, `\` escapes, `_-+*/&|<>=` are
/// symbol characters and the rest of ASCII punctuation is punctuation.
/// Other letters and digits are words, other characters punctuation.
pub fn standard_entry(c: char) -> Entry {
    use std::sync::OnceLock;
    // Emacs's standard syntax table, from its own, each run's descriptor parsed once.
    static ENTRIES: OnceLock<Vec<Entry>> = OnceLock::new();
    let entries = ENTRIES.get_or_init(|| {
        crate::chartab_data::SYNTAX.iter().map(|(_, _, d)| Entry::parse(d).unwrap_or(Entry::new(Class::Punct))).collect()
    });
    let u = c as u32;
    let i = crate::chartab_data::SYNTAX.partition_point(|&(_, last, _)| last < u);
    entries.get(i).copied().unwrap_or(Entry::new(Class::Punct))
}

/// The syntax tables, by name, and what each buffer's characters are.
#[derive(Clone, Debug, Default)]
pub struct SyntaxTables {
    tables: HashMap<String, SyntaxTable>,
    /// How many copies `copy-syntax-table` has made, to name the next.
    pub copies: usize,
}

impl SyntaxTables {
    pub fn get(&self, name: &str) -> Option<&SyntaxTable> {
        self.tables.get(name)
    }

    pub fn exists(&self, name: &str) -> bool {
        name == STANDARD || self.tables.contains_key(name)
    }

    /// Makes a table that inherits from `parent`, the standard table if
    /// none, as `make-syntax-table`. A table already made is emptied.
    pub fn make(&mut self, name: &str, parent: Option<&str>) {
        let parent = parent.filter(|p| *p != name).unwrap_or(STANDARD).to_string();
        self.tables.insert(name.to_string(), SyntaxTable { entries: HashMap::new(), parent: Some(parent) });
    }

    /// A new table named `name` holding a copy of `from`'s own entries, with
    /// its parent, as Emacs's `copy-syntax-table`; a copy of the standard
    /// table inherits from it.
    pub fn copy(&mut self, from: &str, name: &str) {
        let original = self.tables.get(from).cloned().unwrap_or_default();
        let parent = if from == STANDARD { None } else { original.parent };
        self.tables.insert(name.to_string(), SyntaxTable { entries: original.entries, parent: Some(parent.unwrap_or_else(|| STANDARD.to_string())) });
    }

    /// Sets a character's entry in a table, as `modify-syntax-entry`.
    pub fn modify(&mut self, name: &str, c: char, entry: Entry) {
        self.tables.entry(name.to_string()).or_default().entries.insert(c, entry);
    }

    /// A character's entry, looked up in the table and those it inherits from.
    pub fn entry(&self, name: &str, c: char) -> Entry {
        let mut table = Some(name);
        // Guard against a table that inherits from itself, through others.
        for _ in 0..16 {
            let Some(t) = table.and_then(|n| self.tables.get(n)) else { break };
            if let Some(e) = t.entries.get(&c)
                && e.class != Class::Inherit
            {
                return *e;
            }
            table = t.parent.as_deref();
        }
        standard_entry(c)
    }
}

/// A position's place among parens, strings and comments, as the list
/// Emacs's `parse-partial-sexp` returns.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParseState {
    /// How deep in parens.
    pub depth: i64,
    /// Where the innermost list containing the end starts.
    pub innermost_start: Option<usize>,
    /// Where the last complete expression before the end starts.
    pub last_complete: Option<usize>,
    /// The character that will end the string the end is in, `Some('|')`
    /// for a string fence, or none outside a string.
    pub in_string: Option<char>,
    /// Inside a comment: none outside one, `Some(-1)` in one that does
    /// not nest, else how deeply nested.
    pub in_comment: Option<i64>,
    /// Whether the end follows an escape or character quote.
    pub quoted: bool,
    /// The least depth reached.
    pub min_depth: i64,
    /// The style of the comment the end is in: 0, 1 (b), 2 (c) or 3 for a fence.
    pub comment_style: u8,
    /// Where the string or comment the end is in starts.
    pub string_or_comment_start: Option<usize>,
    /// Where each list containing the end starts, outermost first.
    pub open_parens: Vec<usize>,
}

/// An error from scanning, as Emacs's `scan-error`, with the positions it
/// names, shown as Emacs shows one: Scan error: "...", 3, 10.
fn scan_error(message: &str, from: usize, to: usize) -> Error {
    use crate::variables::Value;
    Error::signal(
        "scan-error",
        format!("Scan error: \"{message}\", {}, {}", from + 1, to + 1),
        vec![Value::Str(message.to_string()), Value::Number((from + 1) as f64), Value::Number((to + 1) as f64)],
    )
}

/// How many characters a scanner reads from the buffer at a time.
const CHUNK: usize = 4096;
/// How far apart syntax-ppss keeps parse states, as syntax-ppss-max-span.
const PPSS_SPAN: usize = 20_000;

/// Reads a buffer's text through its syntax table.
pub struct Scanner<'a> {
    pub buffer: &'a Buffer,
    pub tables: &'a SyntaxTables,
    pub table: &'a str,
    /// Whether comments count as whitespace, as `parse-sexp-ignore-comments`.
    pub ignore_comments: bool,
    /// The accessible part of the buffer.
    pub min: usize,
    pub max: usize,
    /// The text around where the scanner last read, and where it starts:
    /// scans read along the text, and the rope is slow one character at a time.
    chunk: std::cell::RefCell<(usize, Vec<char>)>,
    /// The table's entries for ASCII, looked up once.
    ascii: [Entry; 128],
    /// Whether a character's `syntax-table` property, a descriptor such as
    /// ".", overrides the table, as `parse-sexp-lookup-properties` says.
    pub lookup_properties: bool,
    /// The flag a long scan checks, if quitting can stop it.
    pub quit: Option<&'a crate::quit::QuitState>,
    /// Steps since the scan last checked it.
    steps: std::cell::Cell<u32>,
}

impl<'a> Scanner<'a> {
    pub fn new(buffer: &'a Buffer, tables: &'a SyntaxTables, table: &'a str, ignore_comments: bool, min: usize, max: usize) -> Scanner<'a> {
        let ascii = std::array::from_fn(|i| tables.entry(table, i as u8 as char));
        Scanner { buffer, tables, table, ignore_comments, min, max, chunk: Default::default(), ascii, lookup_properties: false, quit: None, steps: Default::default() }
    }

    pub fn char_at(&self, pos: usize) -> Option<char> {
        if pos < self.min || pos >= self.max {
            return None;
        }
        let mut chunk = self.chunk.borrow_mut();
        let (start, chars) = &mut *chunk;
        if pos < *start || pos >= *start + chars.len() {
            // Around `pos`, as scans go either way.
            *start = pos.saturating_sub(CHUNK / 2).max(self.min);
            *chars = self.buffer.chars_between(*start, (*start + CHUNK).min(self.max));
        }
        chars.get(pos - *start).copied()
    }

    /// A character's entry in the scanner's table.
    pub fn entry(&self, c: char) -> Entry {
        if c.is_ascii() { self.ascii[c as usize] } else { self.tables.entry(self.table, c) }
    }

    pub fn entry_at(&self, pos: usize) -> Option<Entry> {
        self.char_at(pos).map(|c| self.entry_for(pos, c))
    }

    /// The entry of the character `c` at `pos`: its `syntax-table`
    /// property's, if properties are looked up and it has one, else the table's.
    fn entry_for(&self, pos: usize, c: char) -> Entry {
        if self.lookup_properties
            && let Some(value) = self.buffer.text_property(pos, "syntax-table")
            && let Some(entry) = Entry::from_property(value, self.tables, c)
        {
            return entry;
        }
        self.entry(c)
    }

    /// The parse state at `pos` from the start of the buffer, as syntax-ppss,
    /// from the nearest state the buffer keeps, keeping more along the way.
    pub fn ppss(&self, pos: usize) -> ParseState {
        let pos = pos.min(self.buffer.len());
        let mut full = Scanner::new(self.buffer, self.tables, self.table, self.ignore_comments, 0, self.buffer.len());
        full.lookup_properties = self.lookup_properties;
        let mut cache = self.buffer.ppss_cache.borrow_mut();
        let mut table = self.buffer.ppss_table.borrow_mut();
        if *table != self.table {
            cache.clear();
            *table = self.table.to_string();
        }
        let (mut at, mut state) = cache.iter().rev().find(|(p, _)| *p <= pos).cloned().unwrap_or_default();
        while pos - at > PPSS_SPAN {
            // Kept at the start of a line, which no two-character comment
            // delimiter or escape straddles.
            let target = at + PPSS_SPAN;
            let line_start = self.buffer.line_start(self.buffer.line_of(target));
            let next = if line_start > at {
                line_start
            } else {
                // On a line that long, before any character that could
                // start a two-character delimiter or escape the next.
                let mut p = target;
                while p > at + 1
                    && full.entry_at(p - 1).is_some_and(|e| {
                        e.has(flags::START1) || e.has(flags::END1) || matches!(e.class, Class::Escape | Class::CharQuote)
                    })
                {
                    p -= 1;
                }
                p
            };
            state = full.parse(at, next, state);
            at = next;
            if cache.last().is_none_or(|(p, _)| *p < at) {
                cache.push((at, state.clone()));
            }
        }
        full.parse(at, pos, state)
    }

    pub fn class_at(&self, pos: usize) -> Option<Class> {
        self.entry_at(pos).map(|e| e.class)
    }

    /// Whether the character at `pos` is escaped by an odd number of escape
    /// or character-quote characters before it, as Emacs's char_quoted.
    pub fn char_quoted(&self, pos: usize) -> bool {
        let mut quoted = false;
        let mut p = pos;
        while p > self.min && matches!(self.class_at(p - 1), Some(Class::Escape | Class::CharQuote)) {
            quoted = !quoted;
            p -= 1;
        }
        quoted
    }

    /// Whether a comment starts at `pos`: its class and comment style, how
    /// long its starter is, and whether it nests.
    fn comment_start_at(&self, pos: usize) -> Option<(Class, u8, usize, bool)> {
        let e = self.entry_at(pos)?;
        if let Some(next) = self.entry_at(pos + 1)
            && e.has(flags::START1)
            && next.has(flags::START2)
        {
            return Some((Class::Comment, next.style(), 2, e.has(flags::NESTED) || next.has(flags::NESTED)));
        }
        match e.class {
            Class::Comment => Some((Class::Comment, e.style(), 1, e.has(flags::NESTED))),
            Class::CommentFence => Some((Class::CommentFence, 3, 1, false)),
            _ => None,
        }
    }

    /// Scans forward from just inside a comment of `style` at nesting
    /// `depth` to just past its end, as Emacs's forw_comment. Returns where
    /// it ended, or `Err` with where it stopped if the text ran out first.
    fn forward_comment_body(&self, mut pos: usize, style: u8, nested: bool, mut depth: i64) -> std::result::Result<usize, usize> {
        loop {
            let Some(c) = self.char_at(pos) else { return Err(pos) };
            let e = self.entry_for(pos, c);
            if style == 3 {
                // A comment fence ends at the next fence.
                if e.class == Class::CommentFence {
                    return Ok(pos + 1);
                }
                pos += 1;
                continue;
            }
            if e.class == Class::EndComment && e.style() == style && (!nested || depth <= 1) {
                return Ok(pos + 1);
            }
            if e.class == Class::EndComment && e.style() == style {
                depth -= 1;
                pos += 1;
                continue;
            }
            // Escapes inside comments quote the next character, as
            // comment-end-can-be-escaped allows only for some; skip them.
            // A two-character ender's style is its first character's.
            if let Some(next) = self.entry_at(pos + 1)
                && e.has(flags::END1)
                && next.has(flags::END2)
                && e.style() == style
            {
                if nested && depth > 1 {
                    depth -= 1;
                    pos += 2;
                    continue;
                }
                return Ok(pos + 2);
            }
            if nested
                && let Some(next) = self.entry_at(pos + 1)
                && e.has(flags::START1)
                && next.has(flags::START2)
                && next.style() == style
            {
                depth += 1;
                pos += 2;
                continue;
            }
            if nested && e.class == Class::Comment && e.style() == style {
                depth += 1;
            }
            pos += 1;
        }
    }

    /// Parses forward from `from` to `to`, as Emacs's parse-partial-sexp
    /// with no stopping conditions, starting from `state`.
    pub fn parse(&self, from: usize, to: usize, state: ParseState) -> ParseState {
        let mut st = state;
        let mut pos = from;
        let to = to.min(self.max);
        // Resume inside a string or comment the state says we are in.
        if let Some(term) = st.in_string {
            match self.skip_string_body(pos, to, term) {
                Some(end) => {
                    pos = end;
                    st.in_string = None;
                    st.last_complete = st.string_or_comment_start;
                    st.string_or_comment_start = None;
                }
                None => return st,
            }
        }
        if let Some(depth) = st.in_comment {
            match self.forward_comment_body(pos, st.comment_style, depth >= 0, depth.max(1)) {
                Ok(end) if end <= to => {
                    pos = end;
                    st.in_comment = None;
                    st.string_or_comment_start = None;
                }
                _ => return st,
            }
        }
        while pos < to {
            let quoted = st.quoted;
            st.quoted = false;
            let Some(e) = self.entry_at(pos) else { break };
            if quoted {
                pos += 1;
                continue;
            }
            if let Some((_, style, len, nested)) = self.comment_start_at(pos)
                && pos + len <= to
            {
                let start = pos;
                match self.forward_comment_body(pos + len, style, nested, 1) {
                    Ok(end) if end <= to => {
                        pos = end;
                        continue;
                    }
                    _ => {
                        st.in_comment = Some(if nested { 1 } else { -1 });
                        st.comment_style = style;
                        st.string_or_comment_start = Some(start);
                        return st;
                    }
                }
            }
            match e.class {
                Class::Escape | Class::CharQuote => {
                    st.last_complete = Some(pos);
                    if pos + 1 >= to {
                        st.quoted = true;
                        break;
                    }
                    pos = self.skip_symbol(pos, to);
                }
                Class::Word | Class::Symbol => {
                    st.last_complete = Some(pos);
                    pos = self.skip_symbol(pos, to);
                }
                Class::Open => {
                    st.open_parens.push(pos);
                    st.depth += 1;
                    st.innermost_start = Some(pos);
                    st.last_complete = None;
                    pos += 1;
                }
                Class::Close => {
                    st.depth -= 1;
                    st.min_depth = st.min_depth.min(st.depth);
                    st.last_complete = st.open_parens.pop();
                    st.innermost_start = st.open_parens.last().copied();
                    pos += 1;
                }
                Class::String | Class::StringFence => {
                    let term = if e.class == Class::StringFence { '|' } else { self.char_at(pos).unwrap_or('"') };
                    let start = pos;
                    match self.skip_string_body(pos + 1, to, term) {
                        Some(end) => {
                            st.last_complete = Some(start);
                            pos = end;
                        }
                        None => {
                            st.in_string = Some(term);
                            st.string_or_comment_start = Some(start);
                            return st;
                        }
                    }
                }
                _ => pos += 1,
            }
        }
        st
    }

    /// Moves over a symbol or word from `pos`, with the characters its
    /// escapes quote, not past `to`.
    fn skip_symbol(&self, mut pos: usize, to: usize) -> usize {
        while pos < to {
            match self.class_at(pos) {
                Some(Class::Escape | Class::CharQuote) => pos = (pos + 2).min(to),
                Some(Class::Word | Class::Symbol | Class::Quote) => pos += 1,
                _ => break,
            }
        }
        pos
    }

    /// From inside a string ended by `term` (`'|'` for a fence), the
    /// position just past its end, if it ends before `to`.
    fn skip_string_body(&self, mut pos: usize, to: usize, term: char) -> Option<usize> {
        while pos < to {
            let c = self.char_at(pos)?;
            let class = self.entry_for(pos, c).class;
            if term == '|' && class == Class::StringFence {
                return Some(pos + 1);
            }
            if term != '|' && c == term && class == Class::String {
                return Some(pos + 1);
            }
            if matches!(class, Class::Escape | Class::CharQuote) {
                pos += 1;
            }
            pos += 1;
        }
        None
    }

    /// Where the comment ending just before `pos` starts, if one does, as
    /// Emacs's back_comment, by parsing forward from the start.
    fn comment_ending_at(&self, pos: usize) -> Option<usize> {
        // An ender of one character, as a newline, ends a comment only if
        // something on its line could have started one; most newlines end
        // none, and the parse from the start is long.
        if self.class_at(pos - 1) == Some(Class::EndComment) {
            let mut p = pos - 1;
            let mut starter = false;
            while p > self.min && self.char_at(p - 1) != Some('\n') {
                p -= 1;
                let e = self.entry_at(p).expect("inside the buffer");
                if matches!(e.class, Class::Comment | Class::CommentFence) || e.has(flags::START1) || e.has(flags::START2) {
                    starter = true;
                    break;
                }
            }
            if !starter {
                return None;
            }
        }
        let before = self.ppss(pos - 1);
        if before.in_comment.is_some() {
            let start = before.string_or_comment_start?;
            let after = self.ppss(pos);
            return after.in_comment.is_none().then_some(start);
        }
        // A comment ender two characters long, its first already read.
        if pos >= 2 {
            let earlier = self.ppss(pos - 2);
            let after = self.ppss(pos);
            if earlier.in_comment.is_some() && after.in_comment.is_none() {
                return earlier.string_or_comment_start;
            }
        }
        None
    }

    /// Moves over `count` comments and the whitespace around them, as
    /// Emacs's forward-comment: forward if positive, back if negative.
    /// Returns where it stopped and whether it went over them all.
    pub fn forward_comment(&self, mut pos: usize, mut count: i64) -> (usize, bool) {
        while count > 0 {
            loop {
                let Some(e) = self.entry_at(pos) else { return (pos, false) };
                if let Some((_, style, len, nested)) = self.comment_start_at(pos) {
                    match self.forward_comment_body(pos + len, style, nested, 1) {
                        Ok(end) => {
                            pos = end;
                            break;
                        }
                        Err(end) => return (end, false),
                    }
                }
                // A newline that ends no comment is whitespace, as Emacs's
                // forward-comment counts it.
                if e.class == Class::Whitespace || (e.class == Class::EndComment && self.char_at(pos) == Some('\n')) {
                    pos += 1;
                    continue;
                }
                return (pos, false);
            }
            count -= 1;
        }
        while count < 0 {
            loop {
                if pos <= self.min {
                    return (pos, false);
                }
                let e = self.entry_at(pos - 1).expect("inside the buffer");
                let ends = e.class == Class::EndComment
                    || e.class == Class::CommentFence
                    || (e.has(flags::END2) && pos >= 2 && self.entry_at(pos - 2).is_some_and(|p| p.has(flags::END1)));
                if ends
                    && !self.char_quoted(pos - 1)
                    && let Some(start) = self.comment_ending_at(pos)
                {
                    pos = start;
                    break;
                }
                if e.class == Class::Whitespace || (e.class == Class::EndComment && self.char_at(pos - 1) == Some('\n')) {
                    pos -= 1;
                    continue;
                }
                return (pos, false);
            }
            count += 1;
        }
        (pos, true)
    }

    /// Moves over `count` balanced expressions, or lists if not `sexp`, as
    /// Emacs's scan_lists, starting `depth` levels in. Returns where it
    /// stopped, or none at an end of the buffer with nothing left to scan.
    /// The ASCII characters a scan passes without anything changing but
    /// its count: words, symbols, spaces and punctuation, with no flags,
    /// as the table has them, when no `syntax-table` property can override it.
    fn plain_ascii(&self) -> Option<[bool; 128]> {
        if self.lookup_properties {
            return None;
        }
        let mut plain = [false; 128];
        for (c, e) in self.ascii.iter().enumerate() {
            plain[c] = e.flags == 0 && matches!(e.class, Class::Whitespace | Class::Punct | Class::Word | Class::Symbol);
        }
        Some(plain)
    }

    /// Where a run of plain ASCII characters from `pos` ends, forward, or
    /// with `forward` false where it starts, read from the text's chunks a
    /// byte at a time rather than a character at a time.
    fn skip_plain(&self, pos: usize, plain: &[bool; 128], forward: bool) -> usize {
        let text = self.buffer.text();
        let is_plain = |b: u8| b < 128 && plain[b as usize];
        let mut p = pos;
        if forward {
            while p < self.max {
                let byte = text.char_to_byte(p);
                let (chunk, chunk_byte, _, _) = text.chunk_at_byte(byte);
                let run = chunk.as_bytes()[byte - chunk_byte..].iter().take(self.max - p).take_while(|&&b| is_plain(b)).count();
                p += run;
                if run == 0 || byte + run < chunk_byte + chunk.len() {
                    break;
                }
            }
        } else {
            while p > self.min {
                let byte = text.char_to_byte(p);
                let (chunk, chunk_byte, _, _) = text.chunk_at_byte(byte - 1);
                let run = chunk.as_bytes()[..byte - chunk_byte].iter().rev().take(p - self.min).take_while(|&&b| is_plain(b)).count();
                p -= run;
                if run == 0 || byte - run > chunk_byte {
                    break;
                }
            }
        }
        p
    }

    /// Signals `quit` every so many steps if the user asked to quit, as
    /// Emacs's scan_lists checks while it scans.
    fn maybe_quit(&self) -> Result<()> {
        let n = self.steps.get().wrapping_add(1);
        self.steps.set(n);
        match self.quit {
            Some(q) if n.is_multiple_of(4096) => q.check(),
            _ => Ok(()),
        }
    }

    pub fn scan_lists(&self, from: usize, mut count: i64, mut depth: i64, sexp: bool) -> Result<Option<usize>> {
        let min_depth = depth.min(0);
        let mut pos = from.clamp(self.min, self.max);
        let mut last_good = pos;
        let plain = self.plain_ascii();
        while count > 0 {
            let mut done = false;
            while pos < self.max {
                // Plain text changes nothing in a list, nor anything but the
                // count of expressions at the top, which cannot run out when
                // there are more to pass than characters left, as
                // electric-pair asks to check a balance to the buffer's end.
                if let Some(plain) = &plain
                    && (!sexp || depth != 0 || count > (self.max - pos) as i64)
                {
                    // A run may be long, so each checks for a quit.
                    if let Some(q) = self.quit {
                        q.check()?;
                    }
                    let to = self.skip_plain(pos, plain, true);
                    if to > pos {
                        if sexp && depth == 0 {
                            count -= (to - pos) as i64;
                        }
                        // The last character passed, as the scan notes each.
                        if depth == min_depth {
                            last_good = to - 1;
                        }
                        pos = to;
                        continue;
                    }
                }
                self.maybe_quit()?;
                let e = self.entry_at(pos).expect("inside the buffer");
                if depth == min_depth {
                    last_good = pos;
                }
                if self.ignore_comments
                    && let Some((_, style, len, nested)) = self.comment_start_at(pos)
                {
                    match self.forward_comment_body(pos + len, style, nested, 1) {
                        Ok(end) => {
                            pos = end;
                            continue;
                        }
                        Err(end) => {
                            if depth == 0 {
                                pos = end;
                                done = true;
                                break;
                            }
                            return Err(scan_error("Unbalanced parentheses", last_good, end));
                        }
                    }
                }
                pos += 1;
                if e.has(flags::PREFIX) {
                    continue;
                }
                match e.class {
                    Class::Escape | Class::CharQuote | Class::Word | Class::Symbol => {
                        if matches!(e.class, Class::Escape | Class::CharQuote) {
                            if pos >= self.max {
                                return Err(scan_error("Unbalanced parentheses", last_good, pos));
                            }
                            pos += 1;
                        }
                        if depth != 0 || !sexp {
                            continue;
                        }
                        // To the end of the symbol; an escape with nothing
                        // after it leaves it unbalanced.
                        while pos < self.max {
                            match self.class_at(pos) {
                                Some(Class::Escape | Class::CharQuote) => {
                                    pos += 1;
                                    if pos == self.max {
                                        return Err(scan_error("Unbalanced parentheses", last_good, pos));
                                    }
                                    pos += 1;
                                }
                                Some(Class::Word | Class::Symbol | Class::Quote) => pos += 1,
                                _ => break,
                            }
                        }
                        done = true;
                        break;
                    }
                    Class::Open => {
                        depth += 1;
                        if depth == 0 {
                            done = true;
                            break;
                        }
                    }
                    Class::Close => {
                        depth -= 1;
                        if depth == 0 {
                            done = true;
                            break;
                        }
                        if depth < min_depth {
                            return Err(scan_error("Containing expression ends prematurely", last_good, pos));
                        }
                    }
                    Class::String | Class::StringFence => {
                        let term = if e.class == Class::StringFence { '|' } else { self.char_at(pos - 1).unwrap_or('"') };
                        match self.skip_string_body(pos, self.max, term) {
                            Some(end) => pos = end,
                            None => return Err(scan_error("Unbalanced parentheses", last_good, self.max)),
                        }
                        if depth == 0 && sexp {
                            done = true;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if !done {
                if depth != 0 {
                    return Err(scan_error("Unbalanced parentheses", last_good, pos));
                }
                return Ok(None);
            }
            count -= 1;
        }
        while count < 0 {
            let mut done = false;
            while pos > self.min {
                if let Some(plain) = &plain
                    && (!sexp || depth != 0 || -count > (pos - self.min) as i64)
                {
                    if let Some(q) = self.quit {
                        q.check()?;
                    }
                    let to = self.skip_plain(pos, plain, false);
                    if to < pos {
                        if sexp && depth == 0 {
                            count += (pos - to) as i64;
                        }
                        if depth == min_depth {
                            last_good = to;
                        }
                        pos = to;
                        continue;
                    }
                }
                self.maybe_quit()?;
                pos -= 1;
                let mut e = self.entry_at(pos).expect("inside the buffer");
                if depth == min_depth {
                    last_good = pos;
                }
                // A comment ending here, skipped whole.
                if self.ignore_comments {
                    let ends = e.class == Class::EndComment
                        || e.class == Class::CommentFence
                        || (e.has(flags::END2) && pos > self.min && self.entry_at(pos - 1).is_some_and(|p| p.has(flags::END1)));
                    if ends
                        && !self.char_quoted(pos)
                        && let Some(start) = self.comment_ending_at(pos + 1)
                    {
                        pos = start;
                        continue;
                    }
                }
                let quoted = self.char_quoted(pos);
                if quoted {
                    pos -= 1;
                    e = Entry::new(Class::Word);
                } else if e.has(flags::PREFIX) {
                    continue;
                }
                match e.class {
                    Class::Word | Class::Symbol | Class::Escape | Class::CharQuote => {
                        if depth != 0 || !sexp {
                            continue;
                        }
                        // Back to the start of the symbol, quoted characters and all.
                        while pos > self.min {
                            let mut temp = pos - 1;
                            if self.class_at(temp) == Some(Class::EndComment) {
                                break;
                            }
                            let q = self.char_quoted(temp);
                            if q {
                                temp -= 1;
                            } else if !matches!(self.class_at(temp), Some(Class::Word | Class::Symbol | Class::Quote)) {
                                break;
                            }
                            pos = temp;
                        }
                        done = true;
                        break;
                    }
                    Class::Close => {
                        depth += 1;
                        if depth == 0 {
                            done = true;
                            break;
                        }
                    }
                    Class::Open => {
                        depth -= 1;
                        if depth == 0 {
                            done = true;
                            break;
                        }
                        if depth < min_depth {
                            return Err(scan_error("Containing expression ends prematurely", last_good, pos));
                        }
                    }
                    Class::String | Class::StringFence => {
                        let term = self.char_at(pos).unwrap_or('"');
                        let fence = e.class == Class::StringFence;
                        loop {
                            if pos <= self.min {
                                return Err(scan_error("Unbalanced parentheses", last_good, self.min));
                            }
                            pos -= 1;
                            if self.char_quoted(pos) {
                                continue;
                            }
                            let class = self.class_at(pos).expect("inside the buffer");
                            if (fence && class == Class::StringFence)
                                || (!fence && self.char_at(pos) == Some(term) && class == Class::String)
                            {
                                break;
                            }
                        }
                        if depth == 0 && sexp {
                            done = true;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if !done {
                if depth != 0 {
                    return Err(scan_error("Unbalanced parentheses", last_good, pos));
                }
                return Ok(None);
            }
            count += 1;
        }
        Ok(Some(pos))
    }

    /// Moves back over expression prefix characters, as Emacs's
    /// backward-prefix-chars: quote class, or flagged p.
    pub fn backward_prefix_chars(&self, mut pos: usize) -> usize {
        while pos > self.min {
            let e = self.entry_at(pos - 1).expect("inside the buffer");
            if (e.class == Class::Quote || e.has(flags::PREFIX)) && !self.char_quoted(pos - 1) {
                pos -= 1;
            } else {
                break;
            }
        }
        pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c_tables() -> SyntaxTables {
        let mut tables = SyntaxTables::default();
        tables.make("c", None);
        for (c, d) in [('/', ". 124b"), ('*', ". 23"), ('\n', "> b")] {
            tables.modify("c", c, Entry::parse(d).unwrap());
        }
        tables
    }

    #[test]
    fn descriptors_keep_their_class() {
        assert_eq!(standard_entry(' ').descriptor(), " ");
        assert_eq!(standard_entry('(').descriptor(), "()");
        assert_eq!(Entry::parse(". 124b").unwrap().descriptor(), ". 124b");
        assert_eq!(Entry::parse("w").unwrap().descriptor(), "w");
    }

    #[test]
    fn kept_parse_states_agree_with_parsing_from_the_start() {
        let tables = c_tables();
        let mut b = Buffer::new("t");
        // Delimiters near where states are kept, on long and short lines.
        let mut text = String::new();
        for i in 0..400 {
            text.push_str(&" ".repeat(97 + i % 7));
            text.push_str(if i % 3 == 0 { "/* ( \" */ x\n" } else { "(a \"b\\\" c\") // q\n" });
        }
        text.push_str(&" ".repeat(PPSS_SPAN - 1));
        text.push_str("/* ( \" */ x");
        b.insert(&text).unwrap();
        let scanner = Scanner::new(&b, &tables, "c", true, 0, b.len());
        for pos in (0..b.len()).step_by(997).chain([b.len()]) {
            assert_eq!(scanner.ppss(pos), scanner.parse(0, pos, ParseState::default()), "at {pos}");
        }
    }
}
