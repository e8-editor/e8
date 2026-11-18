//! Completion styles, as Emacs's `completion-styles`: how minibuffer input
//! matches the names it could complete to, and what completing it as far as
//! it goes gives. Styles are tried in order, and the first that matches
//! anything decides.
//!
//! As in Emacs's minibuffer.el, each style turns the input, split at point,
//! into a pattern of literal text and wildcards. A pattern matches a name
//! from its start, each wildcard as little as it can, and completing merges
//! what the matching names share around each wildcard: f-f gives find-file
//! when every match starts so.

/// The characters partial completion takes to separate words, as Emacs's
/// `completion-pcm-word-delimiters`.
const DELIMITERS: &[char] = &['-', '_', '.', '/', ':', '|', ' '];

fn is_delimiter(c: char) -> bool {
    DELIMITERS.contains(&c)
}

/// A piece of a pattern, as minibuffer.el's: literal text, or a wildcard,
/// which all match anything but merge differently.
#[derive(Clone, Debug, PartialEq)]
enum Pat {
    Str(String),
    /// Grows from the left: "a1b" and "a2b" merge to "a".
    Any,
    /// Matches delimiters only, so "a-b" also finds "a->b".
    AnyDelim,
    /// Grows from both ends, and stays as a "*".
    Star,
    /// Like a star, but stays as where point goes.
    Point,
    /// Grows from the right: "a1b" and "a2b" merge to "b".
    Prefix,
}

impl Pat {
    fn text(&self) -> &str {
        match self {
            Pat::Str(s) => s,
            Pat::Star => "*",
            _ => "",
        }
    }
}

fn pattern_string(pattern: &[Pat]) -> String {
    pattern.iter().map(Pat::text).collect()
}

/// Partial completion's pattern for some text, as Emacs's
/// `completion-pcm--string->pattern`: each delimiter may have anything
/// before it, and `*` stands for anything.
fn string_to_pattern(s: &str) -> Vec<Pat> {
    let chars: Vec<char> = s.chars().collect();
    let mut pattern = Vec::new();
    let mut pending = None;
    let mut p0 = 0;
    for (i, &c) in chars.iter().enumerate() {
        if i < p0 || !(is_delimiter(c) || c == '*') {
            continue;
        }
        if p0 != i {
            pattern.extend(pending.take());
            pattern.push(Pat::Str(chars[p0..i].iter().collect()));
        }
        pending = None;
        if c == '*' {
            pattern.push(Pat::Star);
        } else {
            pattern.push(Pat::Any);
            pattern.push(Pat::Str(c.to_string()));
            pending = Some(Pat::AnyDelim);
        }
        p0 = i + 1;
    }
    if chars.len() > p0 {
        pattern.extend(pending);
        pattern.push(Pat::Str(chars[p0..].iter().collect()));
    }
    pattern
}

/// Drops empty text and wildcards another wildcard makes redundant, and a
/// point at the very end, as Emacs's `completion-pcm--optimize-pattern`.
fn optimize(pattern: Vec<Pat>) -> Vec<Pat> {
    let p: Vec<Pat> = pattern.into_iter().filter(|x| !matches!(x, Pat::Str(s) if s.is_empty())).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < p.len() {
        match (&p[i], p.get(i + 1)) {
            (Pat::Any | Pat::AnyDelim, Some(Pat::Any | Pat::Point)) => {}
            (Pat::Point, None) => {}
            (x, _) => out.push(x.clone()),
        }
        i += 1;
    }
    out
}

/// What the input before and after point gives in a style, or `None` for a
/// style E8 does not know. `None` within: emacs22, which only looks
/// before point, matches names by prefix alone.
fn style_pattern(style: &str, before: &str, after: &str) -> Option<Vec<Pat>> {
    let basic = || optimize(vec![Pat::Str(before.into()), Pat::Point, Pat::Str(after.into())]);
    let substring = || {
        let b = basic();
        optimize(if b.first() == Some(&Pat::Any) { b } else { [vec![Pat::Prefix], b].concat() })
    };
    Some(match style {
        "basic" => basic(),
        "emacs22" => vec![Pat::Str(before.into())],
        "substring" => substring(),
        "flex" => optimize(
            substring()
                .into_iter()
                .flat_map(|x| match x {
                    Pat::Str(s) => s.chars().flat_map(|c| [Pat::Str(c.to_string()), Pat::Any]).collect(),
                    x => vec![x],
                })
                .collect(),
        ),
        "partial-completion" => optimize(if after.is_empty() {
            string_to_pattern(before)
        } else {
            [string_to_pattern(before), vec![Pat::Point], string_to_pattern(after)].concat()
        }),
        _ => return None,
    })
}

fn chars_equal(a: char, b: char, fold: bool) -> bool {
    a == b || (fold && a.to_lowercase().eq(b.to_lowercase()))
}

/// Where each wildcard's match ends if the pattern matches the name from its
/// start, each wildcard taking as little as it can, as Emacs's regexp for
/// the pattern does.
fn pattern_match(pattern: &[Pat], name: &[char], fold: bool) -> Option<Vec<usize>> {
    fn go(p: &[Pat], name: &[char], at: usize, fold: bool, ends: &mut Vec<usize>, failed: &mut std::collections::HashSet<(usize, usize)>) -> bool {
        let Some((first, rest)) = p.split_first() else { return true };
        if failed.contains(&(p.len(), at)) {
            return false;
        }
        let found = match first {
            Pat::Str(s) => {
                let s: Vec<char> = s.chars().collect();
                at + s.len() <= name.len()
                    && s.iter().zip(&name[at..]).all(|(&a, &b)| chars_equal(a, b, fold))
                    && go(rest, name, at + s.len(), fold, ends, failed)
            }
            wild => (at..=name.len()).any(|end| {
                if *wild == Pat::AnyDelim && end > at && !is_delimiter(name[end - 1]) {
                    return false;
                }
                ends.push(end);
                let found = go(rest, name, end, fold, ends, failed);
                if !found {
                    ends.pop();
                }
                found
            }),
        };
        if !found {
            failed.insert((p.len(), at));
        }
        found
    }
    let mut ends = Vec::new();
    go(pattern, name, 0, fold, &mut ends, &mut std::collections::HashSet::new()).then_some(ends)
}

/// The names the input matches in a style, or `None` for a style E8 does
/// not know. Case is ignored if `fold` is set, as `completion-ignore-case` asks.
pub fn all_in_style(style: &str, before: &str, after: &str, names: &[String], fold: bool) -> Option<Vec<String>> {
    let pattern = style_pattern(style, before, after)?;
    Some(names.iter().filter(|n| pattern_match(&pattern, &n.chars().collect::<Vec<_>>(), fold).is_some()).cloned().collect())
}

/// The names the input matches and the style that found them: the first of
/// `styles` that matches any, as Emacs's `completion-all-completions`.
pub fn all_completions(styles: &[String], before: &str, after: &str, names: &[String], fold: bool) -> (Option<String>, Vec<String>) {
    for style in styles {
        if let Some(found) = all_in_style(style, before, after, names, fold)
            && !found.is_empty()
        {
            return (Some(style.clone()), found);
        }
    }
    (None, Vec::new())
}

/// The names the whole input matches, as typed with point at its end.
pub fn complete(styles: &[String], input: &str, names: &[String]) -> Vec<String> {
    all_completions(styles, input, "", names, false).1
}

/// What completing as far as the matches allow gives, as Emacs's
/// `completion-try-completion`.
#[derive(Clone, Debug, PartialEq)]
pub enum Try {
    /// Nothing matches.
    None,
    /// The input is the only match.
    Exact,
    /// The input completed, with where point goes in it.
    Completed { text: String, point: usize },
}

/// As Emacs's `try-completion` of a plain string: `Exact` for the only
/// match, else the longest prefix all names starting with it share.
fn try_prefix(s: &str, names: &[String], fold: bool) -> Option<Result<String, ()>> {
    let s_chars: Vec<char> = s.chars().collect();
    let mut matches: Vec<&String> = Vec::new();
    for n in names {
        let c: Vec<char> = n.chars().collect();
        if c.len() >= s_chars.len() && s_chars.iter().zip(&c).all(|(&a, &b)| chars_equal(a, b, fold)) && !matches.contains(&n) {
            matches.push(n);
        }
    }
    let first: Vec<char> = matches.first()?.chars().collect();
    if matches.len() == 1 && *matches[0] == s {
        return Some(Err(()));
    }
    let mut len = first.len();
    for m in &matches[1..] {
        let c: Vec<char> = m.chars().collect();
        len = len.min(first.iter().zip(&c).take_while(|&(&a, &b)| chars_equal(a, b, fold)).count());
    }
    // Typed as the input is, where the names differ only in case.
    let text: String = if len == s_chars.len() { s.to_string() } else { first[..len].iter().collect() };
    Some(Ok(text))
}

/// What each name shares at its end, as Emacs's `completion--common-suffix`.
fn common_suffix(names: &[String]) -> String {
    let reversed: Vec<String> = names.iter().map(|n| n.chars().rev().collect()).collect();
    common_prefix(&reversed).chars().rev().collect()
}

/// Merges what the matching names share around each wildcard of the pattern,
/// as Emacs's `completion-pcm--merge-completions`.
fn merge_completions(names: &[String], pattern: &[Pat], fold: bool) -> Vec<Pat> {
    if names.len() == 1 {
        return vec![Pat::Str(names[0].clone())];
    }
    // Each name chopped at the ends of the wildcards' matches.
    let mut chopped: Vec<std::collections::VecDeque<String>> = names
        .iter()
        .map(|n| {
            let c: Vec<char> = n.chars().collect();
            let ends = pattern_match(pattern, &c, fold).unwrap_or_default();
            let mut pieces = std::collections::VecDeque::new();
            let mut last = 0;
            for e in ends {
                pieces.push_back(c[last..e].iter().collect());
                last = e;
            }
            pieces.push_back(c[last..].iter().collect());
            pieces
        })
        .collect();
    let mut res = Vec::new();
    let mut fixed = String::new();
    for elem in pattern.iter().chain(std::iter::once(&Pat::Any)) {
        if let Pat::Str(s) = elem {
            fixed.push_str(s);
            continue;
        }
        let comps: Vec<String> = chopped.iter_mut().map(|cc| cc.pop_front().unwrap_or_default()).collect();
        let (mut prefix, unique) = match try_prefix(&fixed, &comps, fold) {
            Some(Err(())) => (fixed.clone(), true),
            Some(Ok(p)) => {
                let unique = matches!(try_prefix(&p, &comps, fold), Some(Err(())));
                (p, unique)
            }
            None => (fixed.clone(), false),
        };
        if unique {
            res.push(Pat::Str(prefix));
        } else {
            if *elem == Pat::Prefix {
                prefix = fixed.clone();
            }
            res.push(Pat::Str(prefix.clone()));
            res.push(elem.clone());
            let named = comps.iter().any(|c| if fold { c.to_lowercase() == prefix.to_lowercase() } else { *c == prefix });
            if matches!(elem, Pat::Star | Pat::Point | Pat::Prefix) && !named {
                let skip = prefix.chars().count();
                let rests: Vec<String> = comps.iter().map(|c| c.chars().skip(skip).collect()).collect();
                let suffix = common_suffix(&rests);
                if !suffix.is_empty() {
                    res.push(Pat::Str(suffix));
                }
            }
        }
        fixed.clear();
    }
    res
}

/// Drops from the start of `suffix` what `completion` already ends with,
/// from `point` on, as Emacs's `completion--merge-suffix`.
fn merge_suffix(completion: &str, point: usize, suffix: &str) -> String {
    let chars: Vec<char> = completion.chars().collect();
    for i in point.min(chars.len())..chars.len() {
        let tail: String = chars[i..].iter().collect();
        if suffix.starts_with(&tail) {
            return suffix[tail.len()..].to_string();
        }
    }
    suffix.to_string()
}

/// Completes by merging the names the pattern matches, as Emacs's
/// `completion-pcm--merge-try`.
fn merge_try(pattern: &[Pat], all: &[String], suffix: &str, fold: bool) -> Try {
    if all.is_empty() {
        return Try::None;
    }
    if all.len() == 1 && pattern_string(pattern) == all[0] {
        return Try::Exact;
    }
    let merged = merge_completions(all, pattern, fold);
    // Point goes where the last point, or else the last wildcard, was.
    let at = merged
        .iter()
        .rposition(|x| *x == Pat::Point)
        .or_else(|| merged.iter().rposition(|x| *x == Pat::Any))
        .or_else(|| merged.iter().rposition(|x| *x == Pat::Star));
    let text = pattern_string(&merged);
    let point = at.map_or(text.chars().count(), |at| pattern_string(&merged[..=at]).chars().count());
    let suffix = merge_suffix(&text, text.chars().count().saturating_sub(1), suffix);
    Try::Completed { text: format!("{text}{suffix}"), point }
}

/// As Emacs's `completion-pcm--filename-try-filter`: completing a file name
/// leaves out ./, ../ and ignored extensions if anything else matches.
fn filename_try_filter(all: Vec<String>, ignored: &[String]) -> Vec<String> {
    let kept: Vec<String> = all
        .iter()
        .filter(|f| !(*f == "./" || *f == "../" || ignored.iter().any(|ext| f.ends_with(ext.as_str()))))
        .cloned()
        .collect();
    if kept.is_empty() { all } else { kept }
}

/// What completing in one style gives, or `None` for a style E8 does not know.
pub fn try_in_style(style: &str, before: &str, after: &str, suffix: &str, names: &[String], fold: bool, ignored: Option<&[String]>) -> Option<Try> {
    let point = before.chars().count();
    let plain = |completion: Option<Result<String, ()>>, after: &str| match completion {
        None => Try::None,
        Some(Err(())) if after.is_empty() => Try::Exact,
        Some(Err(())) => Try::Completed { text: format!("{before}{after}"), point },
        Some(Ok(c)) => {
            let after = match (c.ends_with('/'), after.strip_prefix('/')) {
                (true, Some(rest)) => rest.to_string(),
                _ => after.to_string(),
            };
            Try::Completed { point: c.chars().count(), text: format!("{c}{after}") }
        }
    };
    // As Emacs's file-name-completion, ignored extensions are passed over
    // when anything else matches.
    let filtered;
    let plain_names = match ignored {
        Some(ignored) => {
            let prefixed: Vec<String> = names.iter().filter(|n| try_prefix(before, std::slice::from_ref(n), fold).is_some()).cloned().collect();
            filtered = filename_try_filter(prefixed, ignored);
            &filtered[..]
        }
        None => names,
    };
    match style {
        "emacs22" => return Some(plain(try_prefix(before, plain_names, fold), &format!("{after}{suffix}"))),
        "basic" if after.is_empty() => {
            return Some(match try_prefix(before, plain_names, fold) {
                None => Try::None,
                Some(Err(())) => Try::Exact,
                Some(Ok(c)) => {
                    let n = c.chars().count();
                    Try::Completed { text: format!("{c}{}", merge_suffix(&c, point, suffix)), point: n }
                }
            });
        }
        _ => {}
    }
    let pattern = style_pattern(style, before, after)?;
    let mut all: Vec<String> = names.iter().filter(|n| pattern_match(&pattern, &n.chars().collect::<Vec<_>>(), fold).is_some()).cloned().collect();
    all.dedup();
    if let Some(ignored) = ignored {
        all = filename_try_filter(all, ignored);
    }
    Some(merge_try(&pattern, &all, suffix, fold))
}

/// What completing the input gives: the result of the first of `styles`
/// that completes it at all, as Emacs's `completion-try-completion`. `before`
/// and `after` are the parts of what completes, around point; `suffix` is
/// what follows it, such as the rest of a file name after a slash.
/// `ignored`, for file names, lists the endings completion passes over.
pub fn try_completion(
    styles: &[String],
    before: &str,
    after: &str,
    suffix: &str,
    names: &[String],
    fold: bool,
    ignored: Option<&[String]>,
) -> Try {
    for style in styles {
        match try_in_style(style, before, after, suffix, names, fold, ignored) {
            None | Some(Try::None) => {}
            Some(found) => return found,
        }
    }
    Try::None
}

/// How well a flex match fits, as Emacs's `completion--flex-score`: from
/// just above 0 to 1 for the input itself. Each of the input's characters
/// is matched as early as it can be, and each hole between matched
/// characters lowers the score, a long one only a little more than a short
/// one (`flex-score-match-tightness` is 3).
pub fn flex_score(input: &str, candidate: &str, fold: bool) -> f64 {
    let lower = |s: &str| if fold { s.to_lowercase() } else { s.to_string() };
    let cand: Vec<char> = lower(candidate).chars().collect();
    if cand.is_empty() {
        return 0.0;
    }
    let mut at = 0;
    let mut last: Option<usize> = None;
    let mut holes = 0.0;
    let mut matched = 0;
    for c in lower(input).chars() {
        let Some(found) = cand[at..].iter().position(|&d| d == c).map(|i| at + i) else { return 0.0 };
        if let Some(last) = last
            && found > last + 1
        {
            holes += 1.0 + ((found - last - 2) as f64).powf(1.0 / 3.0);
        }
        last = Some(found);
        at = found + 1;
        matched += 1;
    }
    matched as f64 / (cand.len() as f64 * (1.0 + holes))
}

/// Sorts names as Emacs's `completion-all-sorted-completions` does when the
/// table gives no order: by length, then alphabetically, and then those in
/// `history` first, most recent first.
pub fn sort_completions(items: &mut [String], history: &[String]) {
    items.sort_by(|a, b| a.chars().count().cmp(&b.chars().count()).then_with(|| a.cmp(b)));
    let position = |c: &String| history.iter().position(|h| h == c).unwrap_or(usize::MAX);
    items.sort_by_key(position);
}

/// The longest prefix all the strings share.
pub fn common_prefix(items: &[String]) -> String {
    let Some(first) = items.first() else { return String::new() };
    let mut len = first.len();
    for item in &items[1..] {
        len = first
            .char_indices()
            .zip(item.chars())
            .take_while(|((_, a), b)| a == b)
            .last()
            .map_or(0, |((i, a), _)| i + a.len_utf8())
            .min(len);
    }
    first[..len].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn matches(style: &str, input: &str, name: &str) -> bool {
        !all_in_style(style, input, "", &names(&[name]), false).unwrap().is_empty()
    }

    #[test]
    fn partial_completion_matches_word_prefixes() {
        let pcm = "partial-completion";
        assert!(matches(pcm, "f-f", "find-file"));
        assert!(matches(pcm, "f-f", "find-file-other-window"));
        assert!(matches(pcm, "s-w-b", "split-window-below"));
        assert!(!matches(pcm, "f-f", "fundamental-mode"));
        assert!(matches(pcm, "fi*win", "find-file-other-window"));
        assert!(!matches(pcm, "ile", "find-file"));
        assert!(matches(pcm, "", "anything"));
        assert!(matches(pcm, "-", "a-b"), "a delimiter may have anything before it");
        assert!(matches(pcm, "a-b", "a--b"));
    }

    #[test]
    fn the_first_style_that_matches_decides() {
        let candidates = names(&["find-file", "find-file-other-window", "kill-buffer", "write-file"]);
        let styles = names(&["basic", "partial-completion", "substring"]);
        assert_eq!(complete(&styles, "find", &candidates), ["find-file", "find-file-other-window"]);
        assert_eq!(complete(&styles, "f-f-o", &candidates), ["find-file-other-window"]);
        assert_eq!(complete(&styles, "file", &candidates), ["find-file", "find-file-other-window", "write-file"]);
        assert!(complete(&styles, "zzz", &candidates).is_empty());
        assert_eq!(complete(&names(&["flex"]), "kbf", &candidates), ["kill-buffer"]);
    }

    #[test]
    fn point_splits_the_input() {
        let candidates = names(&["file", "fig", "chervil"]);
        let styles = names(&["basic", "partial-completion", "emacs22"]);
        // Nothing starts with f and has cclrp later, so emacs22 decides,
        // which looks only before point.
        assert_eq!(all_completions(&styles, "f", "cclrp", &candidates, false), (Some("emacs22".into()), names(&["file", "fig"])));
        assert_eq!(all_completions(&styles, "f", "le", &candidates, false).1, ["file"]);
    }

    #[test]
    fn completing_merges_what_the_matches_share() {
        let styles = names(&["basic", "partial-completion", "emacs22"]);
        let commands = names(&["find-file", "find-file-other-window", "fundamental-mode"]);
        let complete = |before: &str| try_completion(&styles, before, "", "", &commands, false, None);
        assert_eq!(complete("find-f"), Try::Completed { text: "find-file".into(), point: 9 });
        assert_eq!(complete("f-f"), Try::Completed { text: "find-file".into(), point: 9 });
        assert_eq!(complete("fund"), Try::Completed { text: "fundamental-mode".into(), point: 16 });
        assert_eq!(complete("fundamental-mode"), Try::Exact);
        assert_eq!(complete("zz"), Try::None);
        let flex = try_completion(&names(&["flex"]), "l", "", "", &names(&["file", "chervil", "find-file-other-window"]), false, None);
        assert_eq!(flex, Try::Completed { text: "il".into(), point: 2 }, "every match has il");
    }

    #[test]
    fn flex_scores_prefer_tight_matches() {
        assert_eq!(flex_score("foo", "foo", false), 1.0);
        assert!((flex_score("foo", "barfoobaz", false) - 1.0 / 3.0).abs() < 1e-9);
        // f abr o baz o: two holes of three.
        let holes = 2.0 * (1.0 + 2f64.powf(1.0 / 3.0));
        assert!((flex_score("foo", "fabrobazo", false) - 3.0 / (9.0 * (1.0 + holes))).abs() < 1e-9);
        assert!(flex_score("ff", "find-file", false) > flex_score("ff", "find-file-other-window", false));
        assert_eq!(flex_score("FO", "foo", true), flex_score("fo", "foo", false));
    }

    #[test]
    fn sorting_puts_history_first_then_short_names() {
        let mut items = names(&["beta", "alpha", "ab", "zeta"]);
        sort_completions(&mut items, &[]);
        assert_eq!(items, ["ab", "beta", "zeta", "alpha"]);
        sort_completions(&mut items, &names(&["zeta", "nothing", "alpha"]));
        assert_eq!(items, ["zeta", "alpha", "ab", "beta"]);
    }

    #[test]
    fn common_prefixes() {
        assert_eq!(common_prefix(&names(&["find-file", "find-file-other-window"])), "find-file");
        assert_eq!(common_prefix(&names(&["über", "übel"])), "übe");
        assert_eq!(common_prefix(&[]), "");
    }
}
