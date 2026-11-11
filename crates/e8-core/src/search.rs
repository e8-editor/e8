//! Searching, as Emacs's search.c: literal and regular expression search
//! forward and backward, with match data for the groups of the last match.
//!
//! Regular expressions are Emacs's, matched by [`crate::regexp`] over the
//! buffer with its syntax table; literal searches use the `regex` crate,
//! which is fast at them.

use regex::Regex;

use crate::regexp::{Groups, Haystack, Regexp};
use crate::syntax_table::Class;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};

/// What a search looks for and how.
#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    pub regexp: bool,
    pub backward: bool,
    /// Whether upper and lower case match each other.
    pub case_fold: bool,
    /// How far the search may go: a match must lie before it searching
    /// forward, or after it searching backward.
    pub bound: Option<usize>,
}

/// A match: where it starts and ends, and where each group matched.
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub start: usize,
    pub end: usize,
    /// Group 0 is the whole match.
    pub groups: Vec<Option<(usize, usize)>>,
}

/// Compiles a literal search pattern.
fn compile_literal(pattern: &str, case_fold: bool) -> Result<Regex> {
    let source = regex::escape(pattern);
    let source = if case_fold { format!("(?i){source}") } else { source };
    Regex::new(&source).map_err(|e| Error::signal("invalid-regexp", format!("Invalid regexp: {e}"), Vec::new()))
}

/// A buffer as a regexp sees it: its accessible portion, its point, and
/// its characters' syntax classes. It reads the text in chunks, as the
/// matcher reads one character after another.
pub struct BufferHaystack<'a> {
    buffer: &'a Buffer,
    class: &'a dyn Fn(usize, char) -> Class,
    /// Whether classes come from the table alone, with no `syntax-table` properties.
    fixed: bool,
    chunk: std::cell::RefCell<(usize, Vec<char>)>,
    /// The flag to check while searching, if quitting can stop it.
    quit: Option<&'a crate::quit::QuitState>,
    /// How many characters it reads at a time.
    window: usize,
}

/// How many characters a haystack reads at a time.
const CHUNK: usize = 8192;

impl<'a> BufferHaystack<'a> {
    pub fn new(buffer: &'a Buffer, class: &'a dyn Fn(usize, char) -> Class, fixed: bool) -> BufferHaystack<'a> {
        BufferHaystack { buffer, class, fixed, chunk: std::cell::RefCell::new((0, Vec::new())), quit: None, window: CHUNK }
    }

    /// The same haystack reading `n` characters at a time: fewer suit
    /// matches tried at scattered places, as at each line's start.
    pub fn reading(mut self, n: usize) -> BufferHaystack<'a> {
        self.window = n.max(16);
        self
    }

    /// The same haystack, a search in which `C-g` stops.
    pub fn quitting(mut self, quit: &'a crate::quit::QuitState) -> BufferHaystack<'a> {
        self.quit = Some(quit);
        self
    }
}

impl Haystack for BufferHaystack<'_> {
    fn maybe_quit(&self) -> Result<()> {
        self.quit.map_or(Ok(()), |q| q.check())
    }

    fn char_at(&self, pos: usize) -> Option<char> {
        let (min, max) = (self.buffer.point_min(), self.buffer.point_max());
        if pos < min || pos >= max {
            return None;
        }
        let mut chunk = self.chunk.borrow_mut();
        let (start, chars) = &mut *chunk;
        if pos < *start || pos >= *start + chars.len() {
            // Around `pos`, so reading backward is as quick as forward.
            *start = pos.saturating_sub(self.window / 4).max(min);
            *chars = self.buffer.chars_between(*start, (*start + self.window).min(max));
        }
        chars.get(pos - *start).copied()
    }
    fn min(&self) -> usize {
        self.buffer.point_min()
    }
    fn max(&self) -> usize {
        self.buffer.point_max()
    }
    fn point(&self) -> Option<usize> {
        Some(self.buffer.point())
    }
    fn class_at(&self, pos: usize, c: char) -> Class {
        (self.class)(pos, c)
    }
    fn fixed_classes(&self) -> bool {
        self.fixed
    }
    fn find(&self, from: usize, limit: usize, backward: bool, test: &mut dyn FnMut(usize, char) -> bool) -> Option<usize> {
        let (min, max) = (self.buffer.point_min(), self.buffer.point_max());
        if backward {
            let (mut pos, limit) = (from.min(max.checked_sub(1)?), limit.max(min));
            while pos >= limit {
                // Load the chunk holding `pos`, then look through it.
                self.char_at(pos)?;
                let chunk = self.chunk.borrow();
                let (start, chars) = &*chunk;
                let low = (*start).max(limit);
                let found = (low..=pos).rev().find(|&p| test(p, chars[p - start]));
                if found.is_some() {
                    return found;
                }
                if low == limit || low == 0 {
                    return None;
                }
                pos = low - 1;
            }
            None
        } else {
            let (mut pos, limit) = (from.max(min), limit.min(max));
            while pos < limit {
                self.char_at(pos)?;
                let chunk = self.chunk.borrow();
                let (start, chars) = &*chunk;
                let high = (start + chars.len()).min(limit);
                let found = (pos..high).find(|&p| test(p, chars[p - start]));
                if found.is_some() {
                    return found;
                }
                pos = high;
            }
            None
        }
    }
}

fn to_match(groups: Groups) -> Match {
    let (start, end) = groups[0].expect("group 0 always matches");
    Match { start, end, groups }
}

/// Searches literally in a buffer from `from`, positions counted in
/// characters, copying out only the text a match could lie in: a window
/// near `from` first, then windows twice as large further on, each
/// overlapping the last by a match's length less one, so a match across
/// two is found whole.
fn search_literal(b: &Buffer, pattern: &str, from: usize, options: &SearchOptions) -> Result<Option<Match>> {
    let re = compile_literal(pattern, options.case_fold)?;
    // A narrowed buffer is searched only where it is accessible, as in Emacs.
    let (min, max) = (b.point_min(), b.point_max());
    let from = from.clamp(min, max);
    let (lo, hi) = if options.backward {
        if options.bound.is_some_and(|bound| from < bound) {
            return Ok(None);
        }
        (options.bound.map_or(min, |bound| bound.clamp(min, max)), from)
    } else {
        (from, options.bound.map_or(max, |bound| bound.clamp(min, max)))
    };
    if lo > hi {
        return Ok(None);
    }
    // A match is as many characters as the pattern, folded case or not.
    let overlap = pattern.chars().count().saturating_sub(1);
    let mut size = FIRST_WINDOW;
    let (mut start, mut end) = if options.backward { (hi.saturating_sub(size).max(lo), hi) } else { (lo, (lo + size).min(hi)) };
    loop {
        let found = if options.backward { last_in(b, &re, pattern, start, end) } else { first_in(b, &re, start, end) };
        if found.is_some() {
            return Ok(found);
        }
        if (options.backward && start == lo) || (!options.backward && end == hi) {
            return Ok(None);
        }
        size = (size * 2).min(LAST_WINDOW);
        if options.backward {
            end = (start + overlap).min(end);
            start = end.saturating_sub(size).max(lo);
        } else {
            start = end.saturating_sub(overlap).max(start);
            end = (start + size).min(hi);
        }
    }
}

/// How many characters the first window of a literal search copies, and
/// the most any later one does.
const FIRST_WINDOW: usize = 1 << 14;
const LAST_WINDOW: usize = 1 << 22;

/// A match `regex` found in text copied from the buffer at byte `base`.
fn window_match(b: &Buffer, m: regex::Match, base: usize) -> Match {
    let to_char = |byte: usize| b.text().byte_to_char(base + byte);
    let (start, end) = (to_char(m.start()), to_char(m.end()));
    Match { start, end, groups: vec![Some((start, end))] }
}

/// The first match wholly in `lo..hi`.
fn first_in(b: &Buffer, re: &regex::Regex, lo: usize, hi: usize) -> Option<Match> {
    let text = b.slice(lo..hi);
    let base = b.text().char_to_byte(lo);
    re.find(&text).map(|m| window_match(b, m, base))
}

/// The match that starts last and ends by `hi`, wholly in `lo..hi`, as
/// Emacs's backward search finds: the last of the non-overlapping matches
/// gives the lowest place it can start.
fn last_in(b: &Buffer, re: &regex::Regex, pattern: &str, lo: usize, hi: usize) -> Option<Match> {
    let text = b.slice(lo..hi);
    let base = b.text().char_to_byte(lo);
    let lowest = re.find_iter(&text).last()?;
    // A match starting later overlaps that one, so it starts before it
    // ends and is no longer than a match of the pattern can be (four bytes
    // a character): only those few starts are tried, each against that
    // much text, rather than every start against the rest of the text.
    let mut limit = (lowest.end() + 4 * pattern.chars().count()).min(text.len());
    while !text.is_char_boundary(limit) {
        limit += 1;
    }
    let window = &text[..limit];
    let later = (lowest.start() + 1..lowest.end())
        .rev()
        .filter(|&start| window.is_char_boundary(start))
        .find_map(|start| re.find_at(window, start).filter(|m| m.start() == start));
    Some(window_match(b, later.unwrap_or(lowest), base))
}

/// Whether search case should be folded for a string, as Emacs decides with
/// `case-fold-search` and, for interactive searches, `search-upper-case`:
/// folding is on unless the string has an upper case letter.
pub fn fold_case_for(ed: &Editor, pattern: &str, interactive: bool) -> bool {
    let fold = ed.variable("case-fold-search").is_none_or(|v| v.is_true());
    let upper = interactive
        && ed.variable("search-upper-case").is_none_or(|v| v.is_true())
        && has_upper_case(pattern);
    fold && !upper
}

/// Whether a search string has an upper case letter, ignoring escapes such
/// as `\W` in a regexp.
fn has_upper_case(pattern: &str) -> bool {
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c.is_uppercase() {
            return true;
        }
    }
    false
}

/// Expands a replacement for a match, as Emacs's `replace-match`: `\&` is
/// the whole match, `\N` group N and `\\` a backslash, when `literal` is
/// off. Unless `fixed_case`, the replacement follows the match's case: all
/// capitals if the match is, capitalised if its first letter is.
pub fn expand_replacement(text: &str, m: &Match, replacement: &str, literal: bool, fixed_case: bool) -> Result<String> {
    let mut out = String::new();
    if literal {
        out.push_str(replacement);
    } else {
        let chars: Vec<char> = text.chars().collect();
        let group = |n: usize| -> Result<String> {
            let (s, e) = m.groups.get(n).copied().flatten().ok_or_else(|| Error::new(format!("No group {n} in the match")))?;
            Ok(chars[s - m.start..e - m.start].iter().collect())
        };
        let mut it = replacement.chars();
        while let Some(c) = it.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match it.next() {
                Some('&') => out.push_str(&group(0)?),
                Some(d @ '0'..='9') => out.push_str(&group(d as usize - '0' as usize)?),
                Some('\\') => out.push('\\'),
                Some('?') => return Err(Error::new("\\? in a replacement is not supported")),
                Some(other) => return Err(Error::new(format!("Invalid use of `\\' in replacement text: \\{other}"))),
                None => return Err(Error::new("Invalid use of `\\' in replacement text")),
            }
        }
    }
    if fixed_case {
        return Ok(out);
    }
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return Ok(out);
    }
    let all_upper = letters.iter().all(|c| c.is_uppercase());
    let first_upper = text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).all(|w| {
        w.chars().next().is_some_and(char::is_uppercase)
    });
    Ok(if all_upper && letters.len() > 1 {
        out.to_uppercase()
    } else if first_upper {
        capitalize(&out)
    } else {
        out
    })
}

/// Capitalises each word, as Emacs's `upcase-initials`.
fn capitalize(text: &str) -> String {
    let mut out = String::new();
    let mut start = true;
    for c in text.chars() {
        if start && c.is_alphabetic() {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        start = !c.is_alphanumeric();
    }
    out
}

impl Editor {
    /// A buffer's characters' syntax classes, as its syntax table gives
    /// them, or their `syntax-table` properties where
    /// `parse-sexp-lookup-properties` is on.
    /// Also whether classes come from the table alone. ASCII's are looked
    /// up once.
    pub(crate) fn syntax_classes<'a>(&'a self, b: &'a Buffer) -> (impl Fn(usize, char) -> Class + 'a, bool) {
        let properties = self.variable_in(b, "parse-sexp-lookup-properties").is_some_and(|v| v.is_true());
        let ascii: Vec<Class> = (0..128u8).map(|c| self.syntax_tables.entry(&b.syntax_table, c as char).class).collect();
        let class = move |pos, c: char| {
            if properties
                && let Some(value) = b.text_property(pos, "syntax-table")
                && let Some(entry) = crate::syntax_table::Entry::from_property(value, &self.syntax_tables, c)
            {
                return entry.class;
            }
            if c.is_ascii() { ascii[c as usize] } else { self.syntax_tables.entry(&b.syntax_table, c).class }
        };
        (class, !properties)
    }

    /// The current buffer's own case and category tables, for regexps to
    /// follow while it has them.
    fn search_tables(&self) -> Option<crate::regexp::SearchTables> {
        use std::hash::{Hash, Hasher};
        let (case, categories) = (self.case_maps(), self.category_maps());
        if case.is_none() && categories.is_none() {
            return None;
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.buffer().case_table.or(self.standard_case_table).map(|id| self.case_table_key(id)).hash(&mut hasher);
        let category = self.buffer().category_table.or(self.standard_category_table);
        category.map(|id| (id, self.char_tables.get(&id).map_or(0, |t| t.tick))).hash(&mut hasher);
        Some(crate::regexp::SearchTables { case, categories, key: hasher.finish() | 1 })
    }

    /// Searches the current buffer from `from`, as Emacs's search.c does:
    /// a regexp is Emacs's, and a match searching forward reads nothing
    /// past the bound, and searching backward nothing past `from`.
    pub fn search(&self, pattern: &str, from: usize, options: &SearchOptions) -> Result<Option<Match>> {
        crate::regexp::with_tables(self.search_tables(), || {
            let b = self.buffer();
            if !options.regexp {
                return search_literal(b, pattern, from, options);
            }
            let re = Regexp::cached(pattern, options.case_fold)?;
            let (class, fixed) = self.syntax_classes(b);
            let h = BufferHaystack::new(b, &class, fixed).quitting(&self.quitting);
            let (min, max) = (b.point_min(), b.point_max());
            let from = from.clamp(min, max);
            let found = if options.backward {
                if options.bound.is_some_and(|bound| from < bound) {
                    return Ok(None);
                }
                re.search_backward(&h, from, options.bound.map_or(min, |bound| bound.clamp(min, max)))?
            } else {
                re.search_forward(&h, from, options.bound.map_or(max, |bound| bound.clamp(min, max)))?
            };
            Ok(found.map(to_match))
        })
    }

    /// Each line of the current buffer's accessible portion that an Emacs
    /// regexp matches at the start of: its number, where it starts, and its
    /// text, as a pass with `looking-at` at every line's start would find
    /// them, as Org finds its headings. Faster than one search per line,
    /// and quit stops it.
    pub fn matching_lines(&self, pattern: &str, case_fold: bool) -> Result<Vec<(usize, usize, String)>> {
        let b = self.buffer();
        self.matching_lines_in(pattern, case_fold, b.point_min(), b.point_max())
    }

    /// As [`Editor::matching_lines`], for the lines starting from `from`
    /// up to `to`, within the accessible portion.
    pub fn matching_lines_in(&self, pattern: &str, case_fold: bool, from: usize, to: usize) -> Result<Vec<(usize, usize, String)>> {
        crate::regexp::with_tables(self.search_tables(), || {
            let b = self.buffer();
            let re = Regexp::cached(pattern, case_fold)?;
            let (class, fixed) = self.syntax_classes(b);
            let h = BufferHaystack::new(b, &class, fixed).quitting(&self.quitting).reading(256);
            let (min, max) = (b.point_min().max(from), b.point_max().min(to));
            // Each line's start and first character, found a chunk of the
            // text at a time rather than a character at a time.
            let (mut lines, mut starts) = (Vec::new(), Vec::new());
            // From the start of the line `min` is on, rather than the buffer's.
            let first = b.line_of(min.min(b.len()));
            let (mut pos, mut line, mut at_start) = (b.line_start(first), first, true);
            let chars = |bytes: &[u8]| bytes.iter().filter(|&&b| (b as i8) >= -0x40).count();
            let byte = b.text().char_to_byte(pos);
            let (chunks, chunk_byte, _, _) = b.text().chunks_at_byte(byte);
            let mut skip = byte - chunk_byte;
            for chunk in chunks {
                let chunk = &chunk[std::mem::take(&mut skip)..];
                if pos > max {
                    break;
                }
                let bytes = chunk.as_bytes();
                let mut i = 0;
                while i < bytes.len() {
                    if at_start {
                        if (min..max).contains(&pos) {
                            lines.push(line);
                            starts.push((pos, chunk[i..].chars().next()));
                        }
                        at_start = false;
                    }
                    match memchr::memchr(b'\n', &bytes[i..]) {
                        Some(k) => {
                            pos += chars(&bytes[i..i + k + 1]);
                            i += k + 1;
                            line += 1;
                            at_start = true;
                        }
                        None => {
                            pos += chars(&bytes[i..]);
                            i = bytes.len();
                        }
                    }
                }
            }
            // An empty last line.
            if at_start && (min..=max).contains(&pos) {
                lines.push(line);
                starts.push((pos, None));
            }
            let found = re.matching_starts(&h, &starts, max)?;
            Ok(found.into_iter().map(|k| (lines[k], starts[k].0, b.line_text(lines[k]))).collect())
        })
    }

    /// The match of an Emacs regexp starting exactly at `pos` in the
    /// current buffer, as Emacs's `looking-at` finds it.
    pub fn looking_at(&self, pattern: &str, pos: usize, case_fold: bool) -> Result<Option<Match>> {
        crate::regexp::with_tables(self.search_tables(), || {
            let b = self.buffer();
            let re = Regexp::cached(pattern, case_fold)?;
            let (class, fixed) = self.syntax_classes(b);
            let h = BufferHaystack::new(b, &class, fixed).quitting(&self.quitting);
            let pos = pos.clamp(b.point_min(), b.point_max());
            Ok(re.match_at(&h, pos, b.point_max())?.map(to_match))
        })
    }

    /// Where an Emacs regexp first matches in a string, from `start`, with
    /// its groups, in characters, as Emacs's `string-match`, the current
    /// buffer's syntax table giving the classes.
    pub fn string_match(&self, pattern: &str, text: &str, start: usize, case_fold: bool) -> Result<Option<Match>> {
        crate::regexp::with_tables(self.search_tables(), || {
            let re = Regexp::cached(pattern, case_fold)?;
            let b = self.buffer();
            let ascii: Vec<Class> = (0..128u8).map(|c| self.syntax_tables.entry(&b.syntax_table, c as char).class).collect();
            let class = |c: char| if c.is_ascii() { ascii[c as usize] } else { self.syntax_tables.entry(&b.syntax_table, c).class };
            let h = crate::regexp::StrHaystack { chars: text.chars().collect(), class: &class };
            let len = h.chars.len();
            if start > len {
                return Err(Error::signal("args-out-of-range", format!("Args out of range: {text:?}, {start}"), Vec::new()));
            }
            Ok(re.search_forward(&h, start, len)?.map(to_match))
        })
    }

    /// Searches the current buffer from point, as Emacs's `search-forward`
    /// and its relatives do: on success, point moves to the end of the match
    /// (its start, searching backward) and the match is kept for
    /// [`Editor::match_data`]. `count` finds that many matches in turn.
    pub fn search_buffer(&mut self, pattern: &str, options: &SearchOptions, count: usize) -> Result<Option<Match>> {
        let mut found = None;
        let mut from = self.buffer().point();
        for _ in 0..count.max(1) {
            let Some(m) = self.search(pattern, from, options)? else { return Ok(None) };
            // An empty match where the last one ended would repeat forever.
            from = if options.backward { m.start } else { m.end };
            found = Some(m);
        }
        let m = found.expect("count is at least one");
        self.buffer_mut().set_point(if options.backward { m.start } else { m.end });
        self.match_data = Some(m.clone());
        Ok(Some(m))
    }

    /// The last successful search's match.
    pub fn match_data(&self) -> Option<&Match> {
        self.match_data.as_ref()
    }

    pub fn set_match_data(&mut self, m: Option<Match>) {
        self.match_data = m;
    }

    /// Replaces the text the last search matched, as Emacs's `replace-match`,
    /// leaving point after the replacement. Returns the new text's range.
    pub fn replace_match(&mut self, replacement: &str, literal: bool, fixed_case: bool) -> Result<(usize, usize)> {
        let m = self.match_data.clone().ok_or_else(|| Error::new("No previous search"))?;
        let b = self.buffer();
        if m.end > b.len() {
            return Err(Error::new("The match is out of date"));
        }
        let text = b.slice(m.start..m.end);
        let new = expand_replacement(&text, &m, replacement, literal, fixed_case)?;
        // As in Emacs, a mark at the end of the replaced text ends up at the
        // end of the new text, even where the match was empty.
        let mark_at_end = self.buffer().mark() == Some(m.end);
        self.buffer_mut().set_point(m.start);
        self.replace_range(m.start, m.end, &new)?;
        let end = m.start + new.chars().count();
        let b = self.buffer_mut();
        b.set_point(end);
        if mark_at_end {
            b.set_mark(Some(end));
        }
        self.match_data = Some(Match { start: m.start, end, groups: vec![Some((m.start, end))] });
        Ok((m.start, end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer(text: &str) -> Editor {
        let mut ed = Editor::new();
        ed.buffer_mut().set_text(text);
        ed
    }

    fn find(ed: &Editor, pattern: &str, from: usize, regexp: bool, backward: bool) -> Option<(usize, usize)> {
        let options = SearchOptions { regexp, backward, ..Default::default() };
        ed.search(pattern, from, &options).unwrap().map(|m| (m.start, m.end))
    }

    #[test]
    fn searches_forward_and_backward() {
        let b = buffer("one two one two");
        assert_eq!(find(&b, "two", 0, false, false), Some((4, 7)));
        assert_eq!(find(&b, "two", 5, false, false), Some((12, 15)));
        assert_eq!(find(&b, "one", 15, false, true), Some((8, 11)));
        // Backward, the match must end by the starting point.
        assert_eq!(find(&b, "one", 10, false, true), Some((0, 3)));
        assert_eq!(find(&b, r"o\w*", 15, true, true), Some((14, 15)));
        assert_eq!(find(&b, r"\<t\w+", 0, true, false), Some((4, 7)));
        assert_eq!(find(&b, "three", 0, false, false), None);
    }

    #[test]
    fn positions_count_characters() {
        let b = buffer("héllo wörld");
        assert_eq!(find(&b, "wö", 0, false, false), Some((6, 8)));
        assert_eq!(find(&b, "l", 11, false, true), Some((9, 10)));
    }

    #[test]
    fn replacements_follow_case() {
        let m = |s: usize, e: usize| Match { start: s, end: e, groups: vec![Some((s, e))] };
        assert_eq!(expand_replacement("foo", &m(0, 3), "bar", false, false).unwrap(), "bar");
        assert_eq!(expand_replacement("Foo", &m(0, 3), "bar", false, false).unwrap(), "Bar");
        assert_eq!(expand_replacement("FOO", &m(0, 3), "bar", false, false).unwrap(), "BAR");
        assert_eq!(expand_replacement("FOO", &m(0, 3), "bar", false, true).unwrap(), "bar");
        let groups = Match { start: 0, end: 7, groups: vec![Some((0, 7)), Some((0, 3)), Some((4, 7))] };
        assert_eq!(expand_replacement("abc def", &groups, r"\2 \1 [\&]", false, true).unwrap(), "def abc [abc def]");
    }
}
