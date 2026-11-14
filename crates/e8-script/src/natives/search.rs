//! Searching and matching.

use crate::natives::{natives, Field, Opt};
use crate::*;

natives! {
    fn lookingAt(ed, pattern: String, pos: Option<usize>, fold: Option<bool>) -> bool {
        let case_fold = fold.unwrap_or_else(|| ed.variable("case-fold-search").is_none_or(|v| v.is_true()));
        let pos = pos.unwrap_or(ed.buffer().point());
        let found = ed.looking_at(&pattern, pos, case_fold)?;
        if found.is_some() {
            ed.set_match_data(found.clone());
        }
        Ok(found.is_some())
    }

    /// Whether a search for a string should fold case: case-fold-search, unless
    /// the search is interactive, search-upper-case is on and the string has a
    /// capital letter.
    #[ts = "(pattern: string, interactive?: boolean): boolean"]
    pub fn foldCaseFor(ed, pattern: String, interactive: bool) -> bool {
        Ok(e8_core::search_fold_case(ed, &pattern, interactive))
    }

    /// Read these keys next, after the running command, as if typed again (Emacs's unread-command-events).
    pub fn unreadKeys(ed, keys: String) {
        let keys = e8_core::Key::parse_seq(&keys)
            .ok_or_else(|| e8_core::Error::new(format!("Invalid key sequence: {keys}")))?;
        ed.unread_keys(&keys);
        Ok(())
    }

    fn setKeymapDefault(ed, keymap: EditorValue, command: Option<String>) {
        let map = ed.keymap_of(&keymap)?;
        ed.keymaps_mut().set_default(map, command.as_deref());
        Ok(())
    }

    fn remapCommand(ed, keymap: EditorValue, from: String, to: Option<String>) {
        let map = ed.keymap_of(&keymap)?;
        ed.keymaps_mut().remap(map, &from, to.as_deref());
        Ok(())
    }

    fn search(ed, pattern: String, from: Option<usize>, regexp: bool, backward: bool, bound: Option<usize>, fold: Option<bool>) -> Option<e8_core::Match> {
        let case_fold = fold.unwrap_or_else(|| e8_core::search_fold_case(ed, &pattern, false));
        let options = e8_core::SearchOptions { regexp, backward, case_fold, bound, posix: false };
        let from = from.unwrap_or(ed.buffer().point());
        let found = ed.search(&pattern, from, &options)?;
        if found.is_some() {
            ed.set_match_data(found.clone());
        }
        Ok(found)
    }

    /// The longest match of a regexp starting at a position, point by default, as posix-looking-at; sets the match data.
    #[ts = "(regexp: string, position?: number | null, caseFold?: boolean | null): boolean"]
    pub fn posixLookingAt(ed, regexp: String, pos: Opt<EditorValue>, case_fold: Opt<bool>) -> bool {
        let pos = position(pos)?;
        let fold = case_fold.0.unwrap_or_else(|| e8_core::search_fold_case(ed, &regexp, false));
        let found = ed.posix_looking_at(&regexp, pos.unwrap_or(ed.buffer().point()), fold)?;
        let matched = found.is_some();
        if matched {
            ed.set_match_data(found);
        }
        Ok(matched)
    }

    /// Where a regexp's longest match at the first place one starts is in a string, from `start`, as posix-string-match; sets the match data.
    #[ts = "(regexp: string, string: string, start?: number | null, caseFold?: boolean | null): number | undefined"]
    pub fn posixStringMatch(ed, regexp: String, text: String, start: Opt<EditorValue>, case_fold: Opt<bool>) -> Option<usize> {
        let start = position(start)?;
        let fold = case_fold.0.unwrap_or_else(|| ed.variable("case-fold-search").is_none_or(|v| v.is_true()));
        let found = ed.posix_string_match(&regexp, &text, start.unwrap_or(0), fold)?;
        let at = found.as_ref().map(|m| m.start);
        if found.is_some() {
            ed.set_match_data(found);
        }
        Ok(at)
    }

    /// Search forward for a regexp's longest match at the first place one starts, as posix-search-forward: point moves to its end. Signals search-failed unless `noerror`.
    #[ts = "(regexp: string, bound?: number | null, noerror?: boolean, count?: number): number | undefined"]
    pub fn posixSearchForward(ed, regexp: String, bound: Opt<EditorValue>, noerror: Opt<bool>, count: Opt<f64>) -> Option<usize> {
        posix_search(ed, &regexp, position(bound)?, noerror.0.unwrap_or(false), count.0.unwrap_or(1.0), false)
    }

    /// Search backward for a regexp's longest match at the nearest place one starts, as posix-search-backward: point moves to its start.
    #[ts = "(regexp: string, bound?: number | null, noerror?: boolean, count?: number): number | undefined"]
    pub fn posixSearchBackward(ed, regexp: String, bound: Opt<EditorValue>, noerror: Opt<bool>, count: Opt<f64>) -> Option<usize> {
        posix_search(ed, &regexp, position(bound)?, noerror.0.unwrap_or(false), count.0.unwrap_or(1.0), true)
    }

    /// Move the match data's positions by `n`, as match-data--translate.
    #[ts = "(n: number): undefined"]
    pub fn matchDataTranslate(ed, n: f64) -> Option<bool> {
        if let Some(mut m) = ed.match_data().cloned() {
            let shift = |p: usize| (p as i64 + n as i64).max(0) as usize;
            m.start = shift(m.start);
            m.end = shift(m.end);
            for g in m.groups.iter_mut().flatten() {
                *g = (shift(g.0), shift(g.1));
            }
            ed.set_match_data(Some(m));
        }
        Ok(None)
    }

    /// Each line matching, as `[line, start, text]`.
    fn matchingLines(ed, pattern: String, fold: Option<bool>, from: Option<usize>, to: Option<usize>) -> Vec<Field> {
        let case_fold = fold.unwrap_or_else(|| ed.variable("case-fold-search").is_none_or(|v| v.is_true()));
        let lines = ed.matching_lines_in(&pattern, case_fold, from.unwrap_or(0), to.unwrap_or(usize::MAX))?;
        Ok(lines.into_iter().map(|(line, start, text)| Field::List(vec![line.into(), start.into(), text.into()])).collect())
    }

    /// The last successful search's match.
    #[ts = "(): Match | undefined"]
    pub fn matchData(ed) -> Option<e8_core::Match> {
        Ok(ed.match_data().cloned())
    }

    fn replaceMatch(ed, replacement: String, literal: bool, fixed_case: bool) -> Vec<usize> {
        let (s, e) = ed.replace_match(&replacement, literal, fixed_case)?;
        Ok(vec![s, e])
    }

    fn setOverridingMap(ed, keymap: EditorValue) {
        ed.set_overriding_map(Some(&keymap).filter(|k| !matches!(k, EditorValue::Null)))
    }

    fn overridingMap(ed) -> Option<EditorValue> {
        Ok(ed.overriding_map().map(EditorValue::Keymap))
    }

    /// How many columns text takes on screen, counting wide characters as two (Emacs's string-width).
    pub fn stringWidth(ed, text: String) -> usize {
        Ok(e8_core::display::display_width(&text, 8))
    }
}

/// A posix- search COUNT times, moving point and setting the match data,
/// with re-search-forward's errors.
fn posix_search(ed: &mut Editor, regexp: &str, bound: Option<usize>, noerror: bool, count: f64, backward: bool) -> Result<Option<usize>, e8_core::Error> {
    let point = ed.buffer().point();
    if bound.is_some_and(|b| if backward { b > point } else { b < point }) {
        return Err(e8_core::Error::new("Invalid search bound (wrong side of point)"));
    }
    let backward = backward != (count < 0.0);
    let options = e8_core::SearchOptions { regexp: true, backward, case_fold: e8_core::search_fold_case(ed, regexp, false), bound, posix: true };
    match ed.search_buffer(regexp, &options, count.abs().max(1.0) as usize)? {
        Some(m) => Ok(Some(if backward { m.start } else { m.end })),
        None if noerror => Ok(None),
        None => Err(e8_core::Error::signal("search-failed", format!("Search failed: \"{regexp}\""), vec![EditorValue::Str(regexp.to_string())])),
    }
}

/// A position argument that may be null or left out.
fn position(value: Opt<EditorValue>) -> Result<Option<usize>, e8_core::Error> {
    match value.0 {
        None | Some(EditorValue::Null) => Ok(None),
        Some(EditorValue::Number(n)) if n >= 0.0 => Ok(Some(n as usize)),
        Some(other) => Err(e8_core::xfaces::wrong_type("integer-or-marker-p", &other)),
    }
}
