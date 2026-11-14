# 0091. POSIX searches as Emacs has them

Status: accepted · 2026-11-14

## Context

search.c has four POSIX searches: `posix-search-forward`, `posix-search-backward`, `posix-looking-at` and `posix-string-match`.
- **What they differ in.** Where a regexp could match in more than one way at a place, Emacs's ordinary searches take the first way the matcher finds. These take the longest, as POSIX asks: `a\|ab` on "abc" matches "ab", not "a".
- **Who needs them.** Lisp that parses with alternations whose order would otherwise matter.

E8's regexp engine ([regexp.rs](../layout.md)) is a backtracking matcher like Emacs's regex-emacs.c, and had only the first match. Also missing from search.c:

- `match-data--translate`, which moves the match data;
- the other names of the regexp searches, `search-forward-regexp` and `search-backward-regexp`.

## Decision

- **The longest match.** The matcher gains a POSIX mode, as `re_match_2_internal` has. A match found is kept if it is the longest yet, and the matcher backtracks on for a longer one until every way has been tried, the first of equal length keeping its groups.
- **Searches.** A POSIX search is the ordinary search with that mode, the place a match starts found as before (`SearchOptions::posix`).
- **The four functions.** They set the match data, move point and signal as `re-search-forward` and its kin do:
  - `posixSearchForward` and `posixSearchBackward`, with a bound, no-error and a count;
  - `posixLookingAt` and `posixStringMatch`.

  The `posix-` names are camelCased, and E8 takes case folding as a last argument.
- **The rest.** `match-data--translate` (`matchDataTranslate`), and `search-forward-regexp` and `search-backward-regexp` as `reSearchForward` and `reSearchBackward`.

## Consequences

- **What Lisp gets.** Lisp written on POSIX matching can be ported, and the matcher has one more mode, at no cost to the ordinary searches.
- **Not done.** `newline-cache-check` and `re--describe-compiled`, which only Emacs's own debugging calls.

## Dependencies introduced

None.
