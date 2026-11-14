//! Emacs's regular expressions, as regex-emacs.c matches them: the syntax
//! parsed exactly, with its rules for when `*`, `^` and `$` are special,
//! and compiled to a program for a backtracking machine that reads the
//! buffer, or a string, through a [`Haystack`], asking its syntax table for
//! the classes `\w`, `\sC`, `\b` and `[:space:]` depend on. Alternatives
//! are tried in order and greedy operators try the longest first, as
//! Emacs's matcher does, so the match and its groups are Emacs's.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::error::{Error, Result};
use crate::syntax_table::Class;

/// What a regexp is matched against: characters by position, with the
/// accessible bounds, point, and each character's syntax class.
pub trait Haystack {
    /// The character at `pos`, or `None` outside the bounds.
    fn char_at(&self, pos: usize) -> Option<char>;
    /// Where `\`` and `^` match at the start, and `\'` and `$` at the end.
    fn min(&self) -> usize;
    fn max(&self) -> usize;
    /// Where `\=` matches, or `None`, as in a string.
    fn point(&self) -> Option<usize>;
    /// The syntax class of the character `c` at `pos`.
    fn class_at(&self, pos: usize, c: char) -> Class;
    /// Whether a character's class is the same wherever it is, with no
    /// `syntax-table` properties, so a search can work out once which
    /// characters can start a match.
    fn fixed_classes(&self) -> bool {
        false
    }
    /// Signals `quit` if the user asked to quit, as the matcher checks
    /// between start positions and every so many steps, as Emacs's does.
    fn maybe_quit(&self) -> Result<()> {
        Ok(())
    }
    /// The first position from `from` before `limit`, or with `backward`
    /// the last from `from` down to `limit`, whose character passes `test`.
    /// A haystack that can read faster than one character at a time says so.
    fn find(&self, from: usize, limit: usize, backward: bool, test: &mut dyn FnMut(usize, char) -> bool) -> Option<usize> {
        if backward {
            (limit..=from).rev().find(|&p| self.char_at(p).is_some_and(|c| test(p, c)))
        } else {
            (from..limit).find(|&p| self.char_at(p).is_some_and(|c| test(p, c)))
        }
    }
}

/// A string to match, with a syntax table's classes.
pub struct StrHaystack<'a> {
    pub chars: Vec<char>,
    pub class: &'a dyn Fn(char) -> Class,
}

impl Haystack for StrHaystack<'_> {
    fn char_at(&self, pos: usize) -> Option<char> {
        self.chars.get(pos).copied()
    }
    fn min(&self) -> usize {
        0
    }
    fn max(&self) -> usize {
        self.chars.len()
    }
    fn point(&self) -> Option<usize> {
        None
    }
    fn class_at(&self, _: usize, c: char) -> Class {
        (self.class)(c)
    }
    fn fixed_classes(&self) -> bool {
        true
    }
}

/// A match's groups as positions: group 0 is the whole match, and a group
/// that did not take part is `None`.
pub type Groups = Vec<Option<(usize, usize)>>;

#[derive(Clone, Debug)]
enum Node {
    Empty,
    Char(char),
    /// Any character but a newline, `.`.
    Any,
    Set(Set),
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Group(Option<usize>, Box<Node>),
    /// With `interval`, from `\{N,M\}`, which Emacs never makes possessive.
    Repeat { node: Box<Node>, min: u32, max: Option<u32>, greedy: bool, interval: bool },
    Backref(usize),
    Assert(Assert),
    /// A syntax class, `\sC`, or with `true` its complement, `\SC`.
    Syntax(Class, bool),
    /// A category, `\cC`, or its complement, `\CC`.
    Category(char, bool),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Assert {
    LineStart,
    LineEnd,
    BufStart,
    BufEnd,
    Point,
    WordBound,
    NotWordBound,
    WordStart,
    WordEnd,
    SymbolStart,
    SymbolEnd,
}

/// A bracket expression.
#[derive(Clone, Debug, Default)]
struct Set {
    negated: bool,
    chars: Vec<char>,
    ranges: Vec<(char, char)>,
    classes: Vec<Named>,
}

/// The character classes of bracket expressions, `[:alpha:]` and the rest.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Named {
    Alpha,
    Alnum,
    Digit,
    Xdigit,
    Upper,
    Lower,
    Space,
    Word,
    Punct,
    Blank,
    Cntrl,
    Graph,
    Print,
    Ascii,
    Nonascii,
    Unibyte,
    Multibyte,
}

impl Named {
    fn from_name(name: &str) -> Option<Named> {
        Some(match name {
            "alpha" => Named::Alpha,
            "alnum" => Named::Alnum,
            "digit" => Named::Digit,
            "xdigit" => Named::Xdigit,
            "upper" => Named::Upper,
            "lower" => Named::Lower,
            "space" => Named::Space,
            "word" => Named::Word,
            "punct" => Named::Punct,
            "blank" => Named::Blank,
            "cntrl" => Named::Cntrl,
            "graph" => Named::Graph,
            "print" => Named::Print,
            "ascii" => Named::Ascii,
            "nonascii" => Named::Nonascii,
            "unibyte" => Named::Unibyte,
            "multibyte" => Named::Multibyte,
            _ => return None,
        })
    }

    /// As Emacs's regex matcher and character.c's alphabeticp, graphicp
    /// and the rest decide, from the character's general category and
    /// case for characters past ASCII.
    fn matches(self, c: char, class: Class, fold: bool) -> bool {
        let gc = || general_category(c);
        match self {
            Named::Alpha if c.is_ascii() => c.is_ascii_alphabetic(),
            Named::Alpha => matches!(gc(), "Lu" | "Ll" | "Lt" | "Lm" | "Lo" | "Mn" | "Mc" | "Me" | "Nl"),
            Named::Alnum if c.is_ascii() => c.is_ascii_alphanumeric(),
            Named::Alnum => matches!(gc(), "Lu" | "Ll" | "Lt" | "Lm" | "Lo" | "Mn" | "Mc" | "Me" | "Nl" | "Nd"),
            Named::Digit => c.is_ascii_digit(),
            Named::Xdigit => c.is_ascii_hexdigit(),
            // Under case folding either matches any character with case, as in Emacs.
            Named::Upper => upper_case(c) || (fold && lower_case(c)),
            Named::Lower => lower_case(c) || (fold && upper_case(c)),
            Named::Space => class == Class::Whitespace,
            Named::Word => class == Class::Word,
            // ASCII punctuation, and any other character that is not a word constituent.
            Named::Punct => if c.is_ascii() { c.is_ascii_punctuation() } else { class != Class::Word },
            Named::Blank => c == ' ' || c == '\t' || (!c.is_ascii() && gc() == "Zs"),
            Named::Cntrl => (c as u32) < 32,
            Named::Graph => if c.is_ascii() { c.is_ascii_graphic() } else { !matches!(gc(), "Zs" | "Zl" | "Zp" | "Cc" | "Cs" | "Cn") },
            Named::Print => if c.is_ascii() { c == ' ' || c.is_ascii_graphic() } else { !matches!(gc(), "Cc" | "Cs" | "Cn") },
            Named::Ascii | Named::Unibyte => c.is_ascii(),
            Named::Nonascii | Named::Multibyte => !c.is_ascii(),
        }
    }
}

/// Whether two word constituents next to each other are in different
/// words, as Emacs's word_boundary_p says with the default
/// `word-combining-categories` and `word-separating-categories`: of two
/// scripts they are, unless one is a combining mark or Han next to kana,
/// and of one script they are not, unless hiragana meets katakana.
fn word_boundary(c1: char, c2: char) -> bool {
    if c1.is_ascii() && c2.is_ascii() {
        return false;
    }
    type Pairs = [(Option<char>, Option<char>)];
    const COMBINING: &Pairs = &[(None, Some('^')), (Some('^'), None), (Some('C'), Some('H')), (Some('C'), Some('K'))];
    const SEPARATING: &Pairs = &[(Some('H'), Some('K'))];
    let same = script(c1) == script(c2);
    let (pairs, default) = if same { (SEPARATING, false) } else { (COMBINING, true) };
    let is = |cat: char, c: char| category(cat, c).unwrap_or(false);
    for &(first, second) in pairs {
        let first_ok = first.is_none_or(|a| is(a, c1) && !is(a, c2));
        let second_ok = second.is_none_or(|b| !is(b, c1) && is(b, c2));
        if first_ok && second_ok {
            return !default;
        }
    }
    default
}

/// A character's script, as Emacs's `char-script-table` has it.
fn script(c: char) -> u8 {
    let u = c as u32;
    let table = crate::chartab_data::SCRIPT;
    let i = table.partition_point(|&(_, last, _)| last < u);
    table.get(i).map_or(0, |&(_, _, s)| s)
}

/// A character's Unicode general category, such as "Lu", as Emacs's tables have it.
fn general_category(c: char) -> &'static str {
    let u = c as u32;
    let table = crate::chartab_data::GENERAL_CATEGORY;
    let i = table.partition_point(|&(_, last, _)| last < u);
    table.get(i).filter(|&&(first, _, _)| first <= u).map_or("Cn", |&(_, _, cat)| crate::chartab_data::CATEGORY_NAMES[cat as usize])
}

/// Whether a character is upper case, as Emacs's uppercasep: its lower case differs.
fn upper_case(c: char) -> bool {
    downcase(c) != c
}

/// Whether a character is lower case, as Emacs's lowercasep: not upper
/// case, and its upper case differs.
fn lower_case(c: char) -> bool {
    !upper_case(c) && upcase(c) != c
}

impl Set {
    fn matches_one(&self, c: char, class: &dyn Fn() -> Class, fold: bool) -> bool {
        self.chars.contains(&c)
            || self.ranges.iter().any(|&(a, b)| a <= c && c <= b)
            || (!self.classes.is_empty() && {
                let class = class();
                self.classes.iter().any(|n| n.matches(c, class, fold))
            })
    }

    fn matches(&self, c: char, class: &dyn Fn() -> Class, fold: bool) -> bool {
        let found = self.matches_one(c, class, fold)
            || (fold && [canon(c), downcase(c), upcase(c)].into_iter().any(|f| f != c && self.matches_one(f, class, fold)));
        found != self.negated
    }
}

/// The case and category tables of a buffer that has its own, in effect
/// while a search runs in it; without, the standard ones as generated.
pub(crate) struct SearchTables {
    pub(crate) case: Option<Rc<crate::casetab::CaseMaps>>,
    pub(crate) categories: Option<Rc<crate::category::CategoryMaps>>,
    /// What identifies them, for the compiled patterns kept for them.
    pub(crate) key: u64,
}

thread_local! {
    static TABLES: RefCell<Option<Rc<SearchTables>>> = const { RefCell::new(None) };
}

/// How many searches have tables of their own in effect, on any thread,
/// so the rest look no further than the generated tables.
static OVERRIDDEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Runs `f` with a buffer's own tables in effect, if it has any.
pub(crate) fn with_tables<T>(tables: Option<SearchTables>, f: impl FnOnce() -> T) -> T {
    let Some(tables) = tables else { return f() };
    use std::sync::atomic::Ordering;
    let previous = TABLES.with_borrow_mut(|t| t.replace(Rc::new(tables)));
    OVERRIDDEN.fetch_add(1, Ordering::Relaxed);
    let result = f();
    OVERRIDDEN.fetch_sub(1, Ordering::Relaxed);
    TABLES.with_borrow_mut(|t| *t = previous);
    result
}

fn tables() -> Option<Rc<SearchTables>> {
    if OVERRIDDEN.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        return None;
    }
    TABLES.with_borrow(|t| t.clone())
}

/// A character's case-folded form, as Emacs's case canon table gives it:
/// the lower case of its upper case, so σ, ς and Σ fold together.
fn canon(c: char) -> char {
    downcase(upcase(c))
}

/// A character's lower case in the case table in effect, the standard
/// one as Emacs's unless a buffer has its own.
pub(crate) fn downcase(c: char) -> char {
    if let Some(case) = tables().and_then(|t| t.case.clone()) {
        return case.downcase(c);
    }
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    case_in(crate::chartab_data::DOWNCASE, c)
}

/// A character's upper case in the case table in effect.
pub(crate) fn upcase(c: char) -> char {
    if let Some(case) = tables().and_then(|t| t.case.clone()) {
        return case.upcase(c);
    }
    if c.is_ascii() {
        return c.to_ascii_uppercase();
    }
    case_in(crate::chartab_data::UPCASE, c)
}

fn case_in(table: &[(u32, u32)], c: char) -> char {
    let u = c as u32;
    match table.binary_search_by_key(&u, |&(from, _)| from) {
        Ok(i) => char::from_u32(table[i].1).unwrap_or(c),
        Err(_) => c,
    }
}

fn invalid(message: &str) -> Error {
    Error::signal("invalid-regexp", format!("Invalid regexp: \"{message}\""), vec![crate::Value::Str(message.to_string())])
}

/// Parses Emacs's syntax, as regex_compile reads it.
struct Parser<'a> {
    chars: &'a [char],
    i: usize,
    /// The highest group number given so far.
    groups: usize,
    /// The groups not yet closed, which a back-reference may not name.
    open: Vec<usize>,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }

    fn at_backslash(&self, c: char) -> bool {
        self.chars.get(self.i) == Some(&'\\') && self.chars.get(self.i + 1) == Some(&c)
    }

    /// Alternatives up to the end, or with `group` up to `\)`.
    fn alternatives(&mut self, group: bool) -> Result<Node> {
        let mut branches = vec![self.branch()?];
        while self.at_backslash('|') {
            self.i += 2;
            branches.push(self.branch()?);
        }
        if self.at_backslash(')') {
            if !group {
                return Err(invalid("Unmatched ) or \\)"));
            }
        } else if group {
            return Err(invalid("Unmatched ( or \\("));
        }
        Ok(if branches.len() == 1 { branches.pop().expect("one") } else { Node::Alt(branches) })
    }

    /// Whether `$` at `i` is special: at the end, or before `\)` or `\|`.
    fn dollar_is_special(&self, i: usize) -> bool {
        i + 1 >= self.chars.len() || (self.chars[i + 1] == '\\' && matches!(self.chars.get(i + 2), Some(')') | Some('|')))
    }

    fn branch(&mut self) -> Result<Node> {
        let mut items: Vec<Node> = Vec::new();
        // Where the expression a repetition applies to starts, as
        // regex_compile's laststart: none at the start, or after a special
        // `^`, where `*` is an ordinary character. Assertions such as `\b`
        // and `\`` leave it where it was, so `x\b*` repeats `x\b`.
        let mut last_start: Option<usize> = None;
        let mut at_start = true;
        while let Some(c) = self.peek() {
            if c == '\\' && matches!(self.chars.get(self.i + 1), Some('|') | Some(')')) {
                break;
            }
            match c {
                '*' | '+' | '?' if last_start.is_some() => {
                    let (min, max, greedy) = self.repetition();
                    let node = Self::take_from(&mut items, last_start.expect("checked"));
                    items.push(Node::Repeat { node: Box::new(node), min, max, greedy, interval: false });
                }
                '\\' if self.chars.get(self.i + 1) == Some(&'{') => match last_start {
                    Some(k) => {
                        let (min, max) = self.interval()?;
                        let node = Self::take_from(&mut items, k);
                        items.push(Node::Repeat { node: Box::new(node), min, max, greedy: true, interval: true });
                    }
                    // With nothing before it, a well-formed interval is
                    // ordinary characters, as in Emacs.
                    None => {
                        let saved = self.i;
                        self.interval()?;
                        self.i = saved + 2;
                        last_start = Some(items.len());
                        items.push(Node::Char('{'));
                    }
                },
                '^' if at_start => {
                    self.i += 1;
                    items.push(Node::Assert(Assert::LineStart));
                    last_start = None;
                    at_start = false;
                    continue;
                }
                '$' if self.dollar_is_special(self.i) => {
                    self.i += 1;
                    items.push(Node::Assert(Assert::LineEnd));
                    last_start = None;
                }
                _ => {
                    let atom = self.atom()?;
                    if !matches!(atom, Node::Assert(_)) {
                        last_start = Some(items.len());
                    }
                    items.push(atom);
                }
            }
            at_start = false;
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().expect("one"),
            _ => Node::Concat(items),
        })
    }

    /// The items from `k` on, as one, for a repetition to apply to.
    fn take_from(items: &mut Vec<Node>, k: usize) -> Node {
        let mut taken: Vec<Node> = items.drain(k..).collect();
        if taken.len() == 1 { taken.pop().expect("one") } else { Node::Concat(taken) }
    }

    /// A run of `*`, `+` and `?`, collapsed into one, as regex_compile's
    /// handle_plus does: `*?` and `+?` and `??` do not repeat greedily.
    fn repetition(&mut self) -> (u32, Option<u32>, bool) {
        let (mut zero, mut many, mut greedy) = (false, false, true);
        while let Some(c @ ('*' | '+' | '?')) = self.peek() {
            self.i += 1;
            if c == '?' && (zero || many) {
                greedy = false;
            } else {
                zero |= c != '+';
                many |= c != '?';
            }
        }
        (if zero { 0 } else { 1 }, if many { None } else { Some(1) }, greedy)
    }

    /// `\{N,M\}`, `\{N\}`, `\{,M\}`, `\{N,\}` or `\{\}`, which is `\{0\}`.
    fn interval(&mut self) -> Result<(u32, Option<u32>)> {
        self.i += 2;
        let number = |p: &mut Self| -> Option<u32> {
            let start = p.i;
            while p.peek().is_some_and(|c| c.is_ascii_digit()) {
                p.i += 1;
            }
            (p.i > start).then(|| p.chars[start..p.i].iter().collect::<String>().parse().unwrap_or(u32::MAX))
        };
        let min = number(self);
        let (min, max) = if self.peek() == Some(',') {
            self.i += 1;
            (min.unwrap_or(0), number(self))
        } else {
            let n = min.unwrap_or(0);
            (n, Some(n))
        };
        if !self.at_backslash('}') {
            let closed = (self.i..self.chars.len().saturating_sub(1)).any(|j| self.chars[j] == '\\' && self.chars[j + 1] == '}');
            return Err(invalid(if closed { "Invalid content of \\{\\}" } else { "Unmatched \\{" }));
        }
        self.i += 2;
        if max.is_some_and(|max| max < min) || min > 0xffff || max.is_some_and(|m| m > 0xffff) {
            return Err(invalid("Invalid content of \\{\\}"));
        }
        Ok((min, max))
    }

    fn atom(&mut self) -> Result<Node> {
        let c = self.peek().expect("an atom has a character");
        self.i += 1;
        match c {
            '.' => Ok(Node::Any),
            '[' => self.bracket(),
            '\\' => self.escape(),
            c => Ok(Node::Char(c)),
        }
    }

    fn escape(&mut self) -> Result<Node> {
        let Some(c) = self.peek() else { return Err(invalid("Trailing backslash")) };
        self.i += 1;
        Ok(match c {
            '(' => {
                let number = if self.peek() == Some('?') {
                    self.i += 1;
                    if self.peek().is_none() {
                        return Err(invalid("Unmatched ( or \\("));
                    }
                    let start = self.i;
                    while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                        self.i += 1;
                    }
                    if self.peek().is_none() {
                        return Err(invalid("Premature end of regular expression"));
                    }
                    if self.peek() != Some(':') || self.chars.get(start) == Some(&'0') {
                        return Err(invalid("Invalid regular expression"));
                    }
                    let digits: String = self.chars[start..self.i].iter().collect();
                    self.i += 1;
                    if digits.is_empty() {
                        None
                    } else {
                        // Emacs takes numbers up to 2^31 - 1; the matcher keeps
                        // a slot for every group up to the highest, so a bound
                        // far above any real pattern keeps that small.
                        let n: usize = digits.parse().map_err(|_| invalid("Regular expression too big"))?;
                        if n == 0 {
                            return Err(invalid("Invalid regular expression"));
                        }
                        if n > MAX_GROUP {
                            return Err(invalid("Regular expression too big"));
                        }
                        self.groups = self.groups.max(n);
                        Some(n)
                    }
                } else {
                    self.groups += 1;
                    Some(self.groups)
                };
                if let Some(n) = number {
                    self.open.push(n);
                }
                let inner = self.alternatives(true)?;
                self.i += 2;
                if number.is_some() {
                    self.open.pop();
                }
                Node::Group(number, Box::new(inner))
            }
            '{' => Node::Char('{'),
            d @ '1'..='9' => {
                let n = d as usize - '0' as usize;
                if n > self.groups || self.open.contains(&n) {
                    return Err(invalid("Invalid back reference"));
                }
                Node::Backref(n)
            }
            'w' => Node::Syntax(Class::Word, false),
            'W' => Node::Syntax(Class::Word, true),
            's' | 'S' => {
                let Some(d) = self.peek() else { return Err(invalid("Premature end of regular expression")) };
                self.i += 1;
                match Class::from_char(d) {
                    Some(class) => Node::Syntax(class, c == 'S'),
                    // A class that does not exist matches nothing, and its complement anything.
                    None => Node::Set(Set { negated: c == 'S', ..Set::default() }),
                }
            }
            'c' | 'C' => {
                let Some(d) = self.peek() else { return Err(invalid("Premature end of regular expression")) };
                self.i += 1;
                if category(d, ' ').is_none() {
                    return Err(invalid("Invalid category designator"));
                }
                Node::Category(d, c == 'C')
            }
            '`' => Node::Assert(Assert::BufStart),
            '\'' => Node::Assert(Assert::BufEnd),
            '=' => Node::Assert(Assert::Point),
            'b' => Node::Assert(Assert::WordBound),
            'B' => Node::Assert(Assert::NotWordBound),
            '<' => Node::Assert(Assert::WordStart),
            '>' => Node::Assert(Assert::WordEnd),
            '_' => {
                let d = self.peek();
                self.i += 1;
                match d {
                    Some('<') => Node::Assert(Assert::SymbolStart),
                    Some('>') => Node::Assert(Assert::SymbolEnd),
                    None => return Err(invalid("Premature end of regular expression")),
                    _ => return Err(invalid("Invalid regular expression")),
                }
            }
            // Anything else after a backslash is itself.
            c => Node::Char(c),
        })
    }

    /// A bracket expression, after its `[`.
    fn bracket(&mut self) -> Result<Node> {
        let mut set = Set::default();
        if self.peek() == Some('^') {
            set.negated = true;
            self.i += 1;
        }
        let mut first = true;
        loop {
            let Some(c) = self.peek() else { return Err(invalid("Unmatched [ or [^")) };
            if c == ']' && !first {
                self.i += 1;
                return Ok(Node::Set(set));
            }
            first = false;
            if c == '[' && self.chars.get(self.i + 1) == Some(&':') {
                let close = (self.i + 2..self.chars.len().saturating_sub(1)).find(|&j| self.chars[j] == ':' && self.chars[j + 1] == ']');
                if let Some(close) = close {
                    let name: String = self.chars[self.i + 2..close].iter().collect();
                    let named = Named::from_name(&name).ok_or_else(|| invalid("Invalid character class name"))?;
                    set.classes.push(named);
                    self.i = close + 2;
                    continue;
                }
            }
            self.i += 1;
            // A range, unless the `-` is last.
            if self.peek() == Some('-') && self.chars.get(self.i + 1).is_some_and(|&e| e != ']') {
                let end = self.chars[self.i + 1];
                self.i += 2;
                // A range backwards is empty, as in Emacs.
                if c <= end {
                    set.ranges.push((c, end));
                }
                continue;
            }
            set.chars.push(c);
        }
    }
}

/// Whether the character `c` is in one of the standard category table's
/// categories, as Emacs's tables have them, or `None` for a designator
/// the table does not define.
fn category(designator: char, c: char) -> Option<bool> {
    if let Some(categories) = tables().and_then(|t| t.categories.clone()) {
        return categories.has(designator, c);
    }
    crate::category::standard_category(designator, c)
}

#[derive(Clone, Debug)]
enum Inst {
    Char(char),
    Any,
    Set(usize),
    Syntax(Class, bool),
    Category(char, bool),
    Assert(Assert),
    Backref(usize),
    /// Puts where the match is into a group's start or end slot.
    Save(usize),
    /// Goes on at the first, coming back to the second if that fails.
    Split(usize, usize),
    Jmp(usize),
    /// Notes where an iteration of a loop starts.
    LoopStart(usize),
    /// Goes back to the loop unless the iteration matched nothing, which
    /// ends it, as Emacs's on_failure_jump_loop does.
    LoopEnd { register: usize, back: usize, out: usize },
    /// Ends a bounded repetition if its iteration matched nothing, as the
    /// same check in Emacs's loop for `\{N,M\}` does, and goes on to the next.
    LoopExit { register: usize, out: usize },
    /// As many characters of a syntax class or its complement as there
    /// are, with no going back on them: a loop Emacs judges cannot overlap
    /// what follows it, and so compiles to on_failure_keep_string_jump.
    Span(Class, bool),
    /// A loop of one character test, the instruction after it: as many as
    /// there are, giving them back one at a time, or with `greedy` false as
    /// few as will do, taking one more at a time, as Emacs's simple loops
    /// match, without a failure point for each character.
    Star { greedy: bool },
    Match,
}

/// A compiled regexp.
#[derive(Debug)]
pub struct Regexp {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    groups: usize,
    loops: usize,
    fold: bool,
    /// The instructions a match must start with, or `None` if it can be
    /// empty or start with anything, as Emacs's fastmap says.
    first: Option<Vec<usize>>,
    /// Whether every match starts at the start of a line, with `^`, so a
    /// search need try nowhere else, as Emacs's matcher skips to a newline.
    at_line_start: bool,
}

/// How many instructions a regexp can compile to.
const MAX_INSTS: usize = 1 << 20;

/// How many failure points the matcher keeps before giving up, as Emacs's does.
const MAX_FAILURES: usize = 4_000_000;

struct Compiler {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    loops: usize,
    fold: bool,
}

/// Whether a node tests one character and consumes it.
fn single_char(node: &Node) -> bool {
    matches!(node, Node::Char(_) | Node::Any | Node::Set(_) | Node::Syntax(..) | Node::Category(..))
}

/// What a node starts with, looking into shy groups and sequences, as
/// Emacs's compiled code has nothing for a shy group's brackets.
fn leading(node: &Node) -> Option<&Node> {
    match node {
        Node::Group(None, inner) => leading(inner),
        Node::Concat(items) => items.first().and_then(leading),
        Node::Empty => None,
        other => Some(other),
    }
}

/// The highest group number an explicitly numbered group may have.
const MAX_GROUP: usize = 65_535;

impl Compiler {
    fn push(&mut self, inst: Inst) -> Result<usize> {
        if self.insts.len() >= MAX_INSTS {
            return Err(invalid("Regular expression too big"));
        }
        self.insts.push(inst);
        Ok(self.insts.len() - 1)
    }

    fn emit(&mut self, node: &Node) -> Result<()> {
        self.emit_in(node, None)
    }

    /// Emits a node, `follow` being what comes after it once groups and
    /// alternatives around it end, as Emacs's analysis of loops looks past
    /// a group's end and an alternative's jump.
    fn emit_in(&mut self, node: &Node, follow: Option<&Node>) -> Result<()> {
        match node {
            Node::Empty => {}
            Node::Char(c) => {
                let c = if self.fold { canon(*c) } else { *c };
                self.push(Inst::Char(c))?;
            }
            Node::Any => {
                self.push(Inst::Any)?;
            }
            Node::Set(set) => {
                self.sets.push(set.clone());
                self.push(Inst::Set(self.sets.len() - 1))?;
            }
            Node::Syntax(class, negated) => {
                self.push(Inst::Syntax(*class, *negated))?;
            }
            Node::Category(c, negated) => {
                self.push(Inst::Category(*c, *negated))?;
            }
            Node::Assert(a) => {
                self.push(Inst::Assert(*a))?;
            }
            Node::Backref(n) => {
                self.push(Inst::Backref(*n))?;
            }
            Node::Concat(items) => {
                for (k, item) in items.iter().enumerate() {
                    let next = match items.get(k + 1) {
                        Some(next) => leading(next).or(follow),
                        None => follow,
                    };
                    self.emit_in(item, next)?;
                }
            }
            // Emacs's mutually_exclusive_p takes a `*` or `+` loop of
            // characters that are not words, or not symbols, before \_< for
            // one that can never give characters back, though `_` or a letter
            // can begin a symbol; its matches are what it finds.
            Node::Repeat { node, min, max: None, greedy: true, interval: false }
                if matches!(node.as_ref(), Node::Syntax(Class::Word | Class::Symbol, true))
                    && matches!(follow, Some(Node::Assert(Assert::SymbolStart))) =>
            {
                let Node::Syntax(class, _) = node.as_ref() else { unreachable!("checked") };
                for _ in 0..*min {
                    self.emit(node)?;
                }
                self.push(Inst::Span(*class, true))?;
            }
            Node::Alt(branches) => {
                let mut ends = Vec::new();
                for (k, branch) in branches.iter().enumerate() {
                    if k + 1 < branches.len() {
                        let split = self.push(Inst::Split(0, 0))?;
                        self.emit_in(branch, follow)?;
                        ends.push(self.push(Inst::Jmp(0))?);
                        let next = self.insts.len();
                        self.insts[split] = Inst::Split(split + 1, next);
                    } else {
                        self.emit_in(branch, follow)?;
                    }
                }
                let end = self.insts.len();
                for j in ends {
                    self.insts[j] = Inst::Jmp(end);
                }
            }
            Node::Group(number, inner) => match number {
                Some(n) => {
                    self.push(Inst::Save(2 * n))?;
                    self.emit_in(inner, follow)?;
                    self.push(Inst::Save(2 * n + 1))?;
                }
                None => self.emit_in(inner, follow)?,
            },
            Node::Repeat { node, min, max, greedy, .. } => {
                for _ in 0..*min {
                    self.emit(node)?;
                }
                match max {
                    // A loop of one character never matches nothing, so it
                    // needs no check of that, and no failure point a character.
                    None if single_char(node) => {
                        self.push(Inst::Star { greedy: *greedy })?;
                        self.emit(node)?;
                    }
                    None => {
                        let register = self.loops;
                        self.loops += 1;
                        let split = self.push(Inst::Split(0, 0))?;
                        self.push(Inst::LoopStart(register))?;
                        self.emit(node)?;
                        let end = self.push(Inst::LoopEnd { register, back: split, out: 0 })?;
                        let out = self.insts.len();
                        self.insts[end] = Inst::LoopEnd { register, back: split, out };
                        self.insts[split] = if *greedy { Inst::Split(split + 1, out) } else { Inst::Split(out, split + 1) };
                    }
                    Some(max) => {
                        // Each further iteration may be left out, and one that
                        // matches nothing ends the repetition.
                        let (mut splits, mut exits) = (Vec::new(), Vec::new());
                        for _ in *min..*max {
                            let register = self.loops;
                            self.loops += 1;
                            splits.push(self.push(Inst::Split(0, 0))?);
                            self.push(Inst::LoopStart(register))?;
                            self.emit(node)?;
                            exits.push((self.push(Inst::LoopExit { register, out: 0 })?, register));
                        }
                        let out = self.insts.len();
                        for s in splits {
                            self.insts[s] = if *greedy { Inst::Split(s + 1, out) } else { Inst::Split(out, s + 1) };
                        }
                        for (e, register) in exits {
                            self.insts[e] = Inst::LoopExit { register, out };
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// What the machine undoes when it backtracks.
enum Frame {
    Branch { pc: usize, pos: usize },
    Slot { slot: usize, old: Option<usize> },
    Loop { register: usize, old: usize },
    /// A greedy one-character loop at `pc` that took `count` characters
    /// from `start`, giving one back each time it is returned to.
    Greedy { pc: usize, start: usize, count: usize },
    /// A lazy one-character loop at `pc` that has got to `pos`, taking one
    /// more each time it is returned to.
    Lazy { pc: usize, pos: usize },
}

/// The matcher's working memory, kept from one start position to the next.
struct Scratch {
    slots: Vec<Option<usize>>,
    loops: Vec<usize>,
    stack: Vec<Frame>,
}

/// Which ASCII characters can start a match, worked out once a search
/// where classes do not depend on where a character is.
struct Fastmap {
    ascii: [bool; 128],
}

impl Regexp {
    /// Compiles an Emacs regexp, folding case if `fold`.
    pub fn new(pattern: &str, fold: bool) -> Result<Regexp> {
        let chars: Vec<char> = pattern.chars().collect();
        let mut parser = Parser { chars: &chars, i: 0, groups: 0, open: Vec::new() };
        let node = parser.alternatives(false)?;
        let mut compiler = Compiler { insts: Vec::new(), sets: Vec::new(), loops: 0, fold };
        compiler.emit(&node)?;
        compiler.push(Inst::Match)?;
        let mut re = Regexp { insts: compiler.insts, sets: compiler.sets, groups: parser.groups, loops: compiler.loops, fold, first: None, at_line_start: false };
        re.first = re.first_instructions();
        re.at_line_start = re.anchored_at_line_start();
        Ok(re)
    }

    /// The regexp for a pattern, compiled once and kept, as Emacs caches
    /// its compiled patterns.
    pub fn cached(pattern: &str, fold: bool) -> Result<Rc<Regexp>> {
        thread_local! {
            static CACHE: RefCell<HashMap<(String, bool, u64), Rc<Regexp>>> = RefCell::new(HashMap::new());
        }
        // Folding and categories follow the tables in effect when it compiles.
        let key = (pattern.to_string(), fold, tables().map_or(0, |t| t.key));
        if let Some(re) = CACHE.with_borrow(|c| c.get(&key).cloned()) {
            return Ok(re);
        }
        let re = Rc::new(Regexp::new(pattern, fold)?);
        CACHE.with_borrow_mut(|c| {
            if c.len() >= 512 {
                c.clear();
            }
            c.insert(key, re.clone());
        });
        Ok(re)
    }

    /// How many groups the regexp has, numbered from 1.
    pub fn groups(&self) -> usize {
        self.groups
    }

    /// The instructions that consume the first character of any match.
    fn first_instructions(&self) -> Option<Vec<usize>> {
        let mut found = Vec::new();
        let mut seen = vec![false; self.insts.len()];
        let mut todo = vec![0];
        while let Some(pc) = todo.pop() {
            if std::mem::replace(&mut seen[pc], true) {
                continue;
            }
            match &self.insts[pc] {
                Inst::Char(_) | Inst::Any | Inst::Set(_) | Inst::Syntax(..) | Inst::Category(..) => found.push(pc),
                Inst::Assert(_) | Inst::Save(_) | Inst::LoopStart(_) => todo.push(pc + 1),
                Inst::Split(a, b) => todo.extend([*a, *b]),
                Inst::Jmp(t) => todo.push(*t),
                Inst::LoopEnd { back, out, .. } => todo.extend([*back, *out]),
                Inst::LoopExit { out, .. } => todo.extend([pc + 1, *out]),
                // Each can take nothing, so what follows may start the match too.
                Inst::Star { .. } => todo.extend([pc + 1, pc + 2]),
                Inst::Span(..) | Inst::Backref(_) | Inst::Match => return None,
            }
        }
        Some(found)
    }

    /// Whether every path from the start meets `^` before any character
    /// test, group end or alternative end.
    fn anchored_at_line_start(&self) -> bool {
        let mut seen = vec![false; self.insts.len()];
        let mut todo = vec![0];
        while let Some(pc) = todo.pop() {
            if std::mem::replace(&mut seen[pc], true) {
                continue;
            }
            match &self.insts[pc] {
                Inst::Assert(Assert::LineStart) => {}
                Inst::Save(_) | Inst::LoopStart(_) => todo.push(pc + 1),
                Inst::Split(a, b) => todo.extend([*a, *b]),
                Inst::Jmp(t) => todo.push(*t),
                _ => return false,
            }
        }
        true
    }

    /// Whether the instruction at `pc`, a character test, takes the
    /// character `c` at `pos`.
    fn takes(&self, pc: usize, h: &dyn Haystack, pos: usize, c: char) -> bool {
        match &self.insts[pc] {
            Inst::Char(want) => *want == c || (self.fold && canon(c) == *want),
            Inst::Any => c != '\n',
            Inst::Set(i) => self.sets[*i].matches(c, &|| h.class_at(pos, c), self.fold),
            Inst::Syntax(class, negated) => (h.class_at(pos, c) == *class) != *negated,
            Inst::Category(d, negated) => category(*d, c).unwrap_or(false) != *negated,
            _ => false,
        }
    }

    fn word_at(h: &dyn Haystack, pos: usize) -> bool {
        h.char_at(pos).is_some_and(|c| h.class_at(pos, c) == Class::Word)
    }

    fn symbol_at(h: &dyn Haystack, pos: usize) -> bool {
        h.char_at(pos).is_some_and(|c| matches!(h.class_at(pos, c), Class::Word | Class::Symbol))
    }

    fn holds(a: Assert, h: &dyn Haystack, pos: usize) -> bool {
        let (min, max) = (h.min(), h.max());
        let before = |f: fn(&dyn Haystack, usize) -> bool| pos > min && f(h, pos - 1);
        let after = |f: fn(&dyn Haystack, usize) -> bool| pos < max && f(h, pos);
        // Between two word constituents, a boundary where Emacs's
        // word_boundary_p sees one, as between letters of two scripts.
        let between_words = || match (pos.checked_sub(1).and_then(|p| h.char_at(p)), h.char_at(pos)) {
            (Some(c1), Some(c2)) => word_boundary(c1, c2),
            _ => false,
        };
        match a {
            Assert::LineStart => pos == min || h.char_at(pos - 1) == Some('\n'),
            Assert::LineEnd => pos == max || h.char_at(pos) == Some('\n'),
            Assert::BufStart => pos == min,
            Assert::BufEnd => pos == max,
            Assert::Point => h.point() == Some(pos),
            Assert::WordBound => {
                let (b, a) = (before(Self::word_at), after(Self::word_at));
                pos == min || pos == max || b != a || (b && between_words())
            }
            Assert::NotWordBound => {
                let (b, a) = (before(Self::word_at), after(Self::word_at));
                pos != min && pos != max && b == a && !(b && between_words())
            }
            Assert::WordStart => after(Self::word_at) && (!before(Self::word_at) || between_words()),
            Assert::WordEnd => before(Self::word_at) && (!after(Self::word_at) || between_words()),
            Assert::SymbolStart => after(Self::symbol_at) && !before(Self::symbol_at),
            Assert::SymbolEnd => before(Self::symbol_at) && !after(Self::symbol_at),
        }
    }

    /// Which ASCII characters can start a match, if the haystack's classes
    /// do not depend on position and a match cannot be empty.
    fn fastmap(&self, h: &dyn Haystack) -> Option<Fastmap> {
        let first = self.first.as_ref()?;
        if !h.fixed_classes() {
            return None;
        }
        let mut ascii = [false; 128];
        for (b, slot) in ascii.iter_mut().enumerate() {
            let c = b as u8 as char;
            *slot = first.iter().any(|&pc| self.takes(pc, h, 0, c));
        }
        Some(Fastmap { ascii })
    }

    /// Whether a match could start with the character `c` at `pos`,
    /// before running the machine there.
    fn may_start_with(&self, h: &dyn Haystack, fast: Option<&Fastmap>, pos: usize, c: char) -> bool {
        let Some(first) = &self.first else { return true };
        match fast {
            Some(fast) if c.is_ascii() => fast.ascii[c as usize],
            _ => first.iter().any(|&pc| self.takes(pc, h, pos, c)),
        }
    }

    fn scratch(&self) -> Scratch {
        Scratch { slots: vec![None; 2 * (self.groups + 1)], loops: vec![usize::MAX; self.loops], stack: Vec::new() }
    }

    /// Which of `starts`, each a position and the character there (none at
    /// the end), a match begins at, by their indices, as `looking-at` at
    /// each would say: each character is tested against those that can
    /// start a match first, as Emacs's fastmap skips.
    pub fn matching_starts(&self, h: &dyn Haystack, starts: &[(usize, Option<char>)], limit: usize) -> Result<Vec<usize>> {
        let fast = self.fastmap(h);
        let mut scratch = self.scratch();
        let mut found = Vec::new();
        for (k, &(pos, c)) in starts.iter().enumerate() {
            if k % 1024 == 1023 {
                h.maybe_quit()?;
            }
            if let Some(c) = c
                && !self.may_start_with(h, fast.as_ref(), pos, c)
            {
                continue;
            }
            if self.run(h, pos, limit, &mut scratch)?.is_some() {
                found.push(k);
            }
        }
        Ok(found)
    }

    /// The match starting exactly at `start` that reads no character at or
    /// after `limit`, as Emacs's re_match_2 finds it, with its groups.
    pub fn match_at(&self, h: &dyn Haystack, start: usize, limit: usize) -> Result<Option<Groups>> {
        self.run(h, start, limit, &mut self.scratch())
    }

    /// The longest match starting exactly at `start`, as POSIX asks and
    /// Emacs's `posix-looking-at` finds it.
    pub fn match_at_posix(&self, h: &dyn Haystack, start: usize, limit: usize) -> Result<Option<Groups>> {
        self.run_mode(h, start, limit, &mut self.scratch(), true)
    }

    fn run(&self, h: &dyn Haystack, start: usize, limit: usize, scratch: &mut Scratch) -> Result<Option<Groups>> {
        self.run_mode(h, start, limit, scratch, false)
    }

    /// The matcher. With `posix`, a match found is kept if it is the
    /// longest yet and the matcher backtracks on for a longer one, as
    /// re_match_2_internal does with its best registers, the first of
    /// equal length winning.
    fn run_mode(&self, h: &dyn Haystack, start: usize, limit: usize, scratch: &mut Scratch, posix: bool) -> Result<Option<Groups>> {
        let mut best: Option<Groups> = None;
        let Scratch { slots, loops, stack } = scratch;
        slots.iter_mut().for_each(|s| *s = None);
        loops.iter_mut().for_each(|l| *l = usize::MAX);
        stack.clear();
        let (mut pc, mut pos) = (0, start);
        let limit = limit.min(h.max());
        let take = |pc: usize, pos: usize| pos < limit && h.char_at(pos).is_some_and(|c| self.takes(pc, h, pos, c));
        let mut steps = 0u32;
        loop {
            // A pattern that backtracks without end can still be quit.
            steps = steps.wrapping_add(1);
            if steps.is_multiple_of(65536) {
                h.maybe_quit()?;
            }
            let ok = match &self.insts[pc] {
                Inst::Char(_) | Inst::Any | Inst::Set(_) | Inst::Syntax(..) | Inst::Category(..) => {
                    let taken = take(pc, pos);
                    if taken {
                        pos += 1;
                        pc += 1;
                    }
                    taken
                }
                Inst::Assert(a) => {
                    pc += 1;
                    Self::holds(*a, h, pos)
                }
                Inst::Backref(n) => match (slots[2 * n], slots[2 * n + 1]) {
                    (Some(s), Some(e)) if e >= s => {
                        let len = e - s;
                        let same = pos + len <= limit
                            && (0..len).all(|k| match (h.char_at(s + k), h.char_at(pos + k)) {
                                (Some(a), Some(b)) => a == b || (self.fold && canon(a) == canon(b)),
                                _ => false,
                            });
                        if same {
                            pos += len;
                            pc += 1;
                        }
                        same
                    }
                    // A group that took no part matches nothing, as in Emacs.
                    _ => false,
                },
                Inst::Save(slot) => {
                    stack.push(Frame::Slot { slot: *slot, old: slots[*slot] });
                    slots[*slot] = Some(pos);
                    pc += 1;
                    true
                }
                Inst::Split(a, b) => {
                    if stack.len() >= MAX_FAILURES {
                        return Err(Error::signal("error", "Stack overflow in regexp matcher", Vec::new()));
                    }
                    stack.push(Frame::Branch { pc: *b, pos });
                    pc = *a;
                    true
                }
                Inst::Jmp(t) => {
                    pc = *t;
                    true
                }
                Inst::LoopStart(r) => {
                    stack.push(Frame::Loop { register: *r, old: loops[*r] });
                    loops[*r] = pos;
                    pc += 1;
                    true
                }
                Inst::LoopEnd { register, back, out } => {
                    pc = if loops[*register] == pos { *out } else { *back };
                    true
                }
                Inst::LoopExit { register, out } => {
                    pc = if loops[*register] == pos { *out } else { pc + 1 };
                    true
                }
                Inst::Span(class, negated) => {
                    while pos < limit && h.char_at(pos).is_some_and(|c| (h.class_at(pos, c) == *class) != *negated) {
                        pos += 1;
                    }
                    pc += 1;
                    true
                }
                Inst::Star { greedy: true } => {
                    let from = pos;
                    while take(pc + 1, pos) {
                        pos += 1;
                    }
                    if pos > from {
                        stack.push(Frame::Greedy { pc, start: from, count: pos - from });
                    }
                    pc += 2;
                    true
                }
                Inst::Star { greedy: false } => {
                    stack.push(Frame::Lazy { pc, pos });
                    pc += 2;
                    true
                }
                Inst::Match => {
                    let mut groups: Groups = (0..=self.groups).map(|g| slots[2 * g].zip(slots[2 * g + 1])).collect();
                    groups[0] = Some((start, pos));
                    if !posix {
                        return Ok(Some(groups));
                    }
                    let longer = best.as_ref().is_none_or(|b| b[0].is_some_and(|(_, end)| pos > end));
                    if longer {
                        best = Some(groups);
                    }
                    false
                }
            };
            if !ok {
                loop {
                    match stack.pop() {
                        None => return Ok(best),
                        Some(Frame::Slot { slot, old }) => slots[slot] = old,
                        Some(Frame::Loop { register, old }) => loops[register] = old,
                        Some(Frame::Branch { pc: p, pos: at }) => {
                            pc = p;
                            pos = at;
                            break;
                        }
                        Some(Frame::Greedy { pc: p, start: s, count }) => {
                            let count = count - 1;
                            if count > 0 {
                                stack.push(Frame::Greedy { pc: p, start: s, count });
                            }
                            pc = p + 2;
                            pos = s + count;
                            break;
                        }
                        Some(Frame::Lazy { pc: p, pos: at }) => {
                            if take(p + 1, at) {
                                stack.push(Frame::Lazy { pc: p, pos: at + 1 });
                                pc = p + 2;
                                pos = at + 1;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    /// The first match starting at or after `from` and reading nothing at
    /// or after `limit`, as re-search-forward finds it.
    pub fn search_forward(&self, h: &dyn Haystack, from: usize, limit: usize) -> Result<Option<Groups>> {
        self.search_forward_mode(h, from, limit, false)
    }

    /// The longest match at the first place one starts, as `posix-search-forward`.
    pub fn search_forward_posix(&self, h: &dyn Haystack, from: usize, limit: usize) -> Result<Option<Groups>> {
        self.search_forward_mode(h, from, limit, true)
    }

    fn search_forward_mode(&self, h: &dyn Haystack, from: usize, limit: usize, posix: bool) -> Result<Option<Groups>> {
        let limit = limit.min(h.max());
        let fast = self.fastmap(h);
        let mut scratch = self.scratch();
        let mut start = from;
        let mut tries = 0u32;
        while start <= limit {
            tries = tries.wrapping_add(1);
            if tries.is_multiple_of(256) {
                h.maybe_quit()?;
            }
            // A regexp anchored with `^` can start only at the start of a line.
            if self.at_line_start && start > h.min() && h.char_at(start - 1) != Some('\n') {
                match h.find(start, limit, false, &mut |_, c| c == '\n') {
                    Some(p) => start = p + 1,
                    None => return Ok(None),
                }
                continue;
            }
            // Only where the first character can start a match, as Emacs's fastmap skips.
            if self.first.is_some() {
                let mut test = |pos: usize, c: char| self.may_start_with(h, fast.as_ref(), pos, c);
                match h.find(start, limit, false, &mut test) {
                    Some(p) => start = p,
                    None => return Ok(None),
                }
            }
            if let Some(groups) = self.run_mode(h, start, limit, &mut scratch, posix)? {
                return Ok(Some(groups));
            }
            start += 1;
        }
        Ok(None)
    }

    /// The match starting nearest before `from`, at or after `bound`, that
    /// does not go past `from`, as re-search-backward finds it.
    pub fn search_backward(&self, h: &dyn Haystack, from: usize, bound: usize) -> Result<Option<Groups>> {
        self.search_backward_mode(h, from, bound, false)
    }

    /// The longest match at the nearest place before `from` one starts, as `posix-search-backward`.
    pub fn search_backward_posix(&self, h: &dyn Haystack, from: usize, bound: usize) -> Result<Option<Groups>> {
        self.search_backward_mode(h, from, bound, true)
    }

    fn search_backward_mode(&self, h: &dyn Haystack, from: usize, bound: usize, posix: bool) -> Result<Option<Groups>> {
        let from = from.min(h.max());
        let bound = bound.max(h.min());
        let fast = self.fastmap(h);
        let mut scratch = self.scratch();
        let mut start = from;
        let mut tries = 0u32;
        loop {
            tries = tries.wrapping_add(1);
            if tries.is_multiple_of(256) {
                h.maybe_quit()?;
            }
            if start < bound {
                return Ok(None);
            }
            if self.at_line_start && start > h.min() && h.char_at(start - 1) != Some('\n') {
                // A newline just before the bound starts a line at it.
                match h.find(start - 1, bound.saturating_sub(1).max(h.min()), true, &mut |_, c| c == '\n') {
                    Some(p) => start = p + 1,
                    None if bound == h.min() => start = h.min(),
                    None => return Ok(None),
                }
                continue;
            }
            if self.first.is_some() {
                // A match starting at `from` would be empty, which having a
                // first character rules out.
                if from == 0 || start.min(from - 1) < bound {
                    return Ok(None);
                }
                let top = start.min(from - 1);
                let mut test = |pos: usize, c: char| self.may_start_with(h, fast.as_ref(), pos, c);
                match h.find(top, bound, true, &mut test) {
                    Some(p) => start = p,
                    None => return Ok(None),
                }
            }
            if let Some(groups) = self.run_mode(h, start, from, &mut scratch, posix)? {
                return Ok(Some(groups));
            }
            if start == 0 {
                return Ok(None);
            }
            start -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard(c: char) -> Class {
        crate::syntax_table::SyntaxTables::default().entry(crate::syntax_table::STANDARD, c).class
    }

    /// Emacs's match data for a string, as positions, `None` for no match.
    fn m(re: &str, s: &str) -> Option<Vec<Option<(usize, usize)>>> {
        let h = StrHaystack { chars: s.chars().collect(), class: &standard };
        Regexp::new(re, false).unwrap().search_forward(&h, 0, usize::MAX).unwrap()
    }

    fn folded(re: &str, s: &str) -> bool {
        let h = StrHaystack { chars: s.chars().collect(), class: &standard };
        Regexp::new(re, true).unwrap().search_forward(&h, 0, usize::MAX).unwrap().is_some()
    }

    #[test]
    fn case_folds_through_the_canonical_case() {
        assert!(folded("σ", "ς") && folded("Σ", "ς") && folded("ς", "σ"));
        assert!(folded("µ", "μ") && folded("[σ]", "Σ"));
        assert!(!folded("k", "\u{212a}"), "the Kelvin sign is its own");
        assert!(folded("[a-z]", "Q") && folded("q", "Q"));
    }

    #[test]
    fn a_very_long_line_does_not_overflow() {
        let line = "x".repeat(3_000_000);
        assert_eq!(m("^.*$", &line), Some(vec![Some((0, 3_000_000))]));
        assert_eq!(m("x*\\'", &line), Some(vec![Some((0, 3_000_000))]));
    }

    #[test]
    fn errors_are_emacs_s() {
        let message = |re: &str| Regexp::new(re, false).unwrap_err().to_string();
        assert_eq!(message("a\\{2"), r#"Invalid regexp: "Unmatched \{""#);
        assert_eq!(message("\\{"), r#"Invalid regexp: "Unmatched \{""#);
        assert_eq!(message("\\(?1"), "Invalid regexp: \"Premature end of regular expression\"");
        assert_eq!(message("\\_"), "Invalid regexp: \"Premature end of regular expression\"");
        assert_eq!(message("\\_x"), "Invalid regexp: \"Invalid regular expression\"");
        assert!(Regexp::new("\\(?01:a\\)", false).is_err());
        // A group number too big to keep slots for is refused, not allocated.
        assert_eq!(message("\\(?4000000000:x\\)"), "Invalid regexp: \"Regular expression too big\"");
        assert_eq!(message("\\(?99999999999999999999999:x\\)"), "Invalid regexp: \"Regular expression too big\"");
        assert!(Regexp::new("\\(?300:x\\)", false).is_ok());
    }

    #[test]
    fn matches_as_emacs_does() {
        // Each from Emacs 30's string-match and match-data.
        assert_eq!(m(r"\(a*\)*", "b"), Some(vec![Some((0, 0)), Some((0, 0))]));
        assert_eq!(m(r"\(a*\)*b", "aab"), Some(vec![Some((0, 3)), Some((2, 2))]));
        assert_eq!(m(r"\(a\|ab\)\(c\|bcd\)", "abcd"), Some(vec![Some((0, 4)), Some((0, 1)), Some((1, 4))]));
        assert_eq!(m("a+?", "aaa"), Some(vec![Some((0, 1))]));
        assert_eq!(m(r"a\{2\}*", "aaaaa"), Some(vec![Some((0, 4))]));
        assert_eq!(m(r"a\{\}", "aaa"), Some(vec![Some((0, 0))]));
        assert_eq!(m(r"\(?2:a\)\(b\)", "ab"), Some(vec![Some((0, 2)), None, Some((0, 1)), Some((1, 2))]));
        assert_eq!(m(r"\(?:a\(b\)?\)*", "aba"), Some(vec![Some((0, 3)), Some((1, 2))]));
        assert_eq!(m(r"\w+", "a_b"), Some(vec![Some((0, 1))]));
        assert_eq!(m(r"\_<foo\_>", "x foo_bar foo"), Some(vec![Some((10, 13))]));
        assert_eq!(m(r"\(a\)\1", "xaa"), Some(vec![Some((1, 3)), Some((1, 2))]));
        assert_eq!(m("[z-a]", "z"), None);
        // A repetition ends at an iteration that matches nothing.
        assert_eq!(m(r"\(.??\)\{,3\}\<\_<", "(bbA_"), Some(vec![Some((0, 1)), Some((1, 1))]));
        // Emacs never goes back into a loop of non-words before \_<.
        assert_eq!(m(r"^\Sw*\_<", "_a"), None);
        assert_eq!(m("^*a", "*a"), Some(vec![Some((0, 2))]));
        assert_eq!(m("a^b$c", "a^b$c"), Some(vec![Some((0, 5))]));
        assert_eq!(m(r"\b", ""), Some(vec![Some((0, 0))]));
        assert_eq!(m(r"\<", ""), None);
        // As Emacs's laststart: `*` after \` with nothing before is ordinary.
        assert_eq!(m(r"\`*a", "*a"), Some(vec![Some((0, 2))]));
        assert_eq!(m(r"\`+a", "+a"), Some(vec![Some((0, 2))]));
        // Emacs makes only a `*` or `+` loop possessive before \_<, seen through shy groups.
        assert_eq!(m(r"\Sw*\(?:\_<\)", "_a"), None);
        assert_eq!(m(r"\S_\{2,\}\_<", "a b"), Some(vec![Some((0, 2))]));
        assert_eq!(m(r"\sZ", "a"), None);
        assert!(Regexp::new(r"\(a\)\2", false).is_err());
        assert!(Regexp::new("[[:foo:]]", false).is_err());
        assert!(Regexp::new(r"a\{3,2\}", false).is_err());
    }
}
