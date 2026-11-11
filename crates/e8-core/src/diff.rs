//! The differences between two sequences, as Emacs's `compareseq` finds
//! them for `replace-buffer-contents`: Myers's algorithm, the fewest
//! deletions and insertions that turn one into the other, given up when
//! they would be more than a limit.

use std::ops::Range;

/// A stretch of the old sequence replaced by one of the new.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old: Range<usize>,
    pub new: Range<usize>,
}

/// The one hunk between what is the same at the start of `a` and `b` and
/// what is the same at their ends, or None if they are the same.
pub fn ends<T: PartialEq>(a: &[T], b: &[T]) -> Option<Hunk> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let room = a.len().min(b.len()) - prefix;
    let suffix = a.iter().rev().zip(b.iter().rev()).take(room).take_while(|(x, y)| x == y).count();
    (prefix + suffix < a.len().max(b.len())).then(|| Hunk { old: prefix..a.len() - suffix, new: prefix..b.len() - suffix })
}

/// The hunks that turn `a` into `b`, in order, or None if that takes more
/// than `max_edits` deletions and insertions. What is the same at both
/// ends is left out before the search, so it costs nothing.
pub fn hunks<T: PartialEq>(a: &[T], b: &[T], max_edits: usize) -> Option<Vec<Hunk>> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let room = a.len().min(b.len()) - prefix;
    let suffix = a.iter().rev().zip(b.iter().rev()).take(room).take_while(|(x, y)| x == y).count();
    let (a_mid, b_mid) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let mut out = myers(a_mid, b_mid, max_edits)?;
    for h in &mut out {
        h.old = h.old.start + prefix..h.old.end + prefix;
        h.new = h.new.start + prefix..h.new.end + prefix;
    }
    Some(out)
}

fn myers<T: PartialEq>(a: &[T], b: &[T], max_edits: usize) -> Option<Vec<Hunk>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    if n == 0 && m == 0 {
        return Some(Vec::new());
    }
    let limit = ((n + m) as usize).min(max_edits) as isize;
    let offset = limit + 1;
    let mut v = vec![0isize; 2 * limit as usize + 3];
    // The furthest x on each diagonal -d..=d before each step d, for the path back.
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    'search: for d in 0..=limit {
        trace.push(v[(offset - d) as usize..=(offset + d) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let i = (k + offset) as usize;
            let mut x = if k == -d || (k != d && v[i - 1] < v[i + 1]) { v[i + 1] } else { v[i - 1] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[i] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'search;
            }
            k += 2;
        }
    }
    let depth = found?;
    // Back along the path: each step is a deletion or an insertion, after a run of matches.
    let mut edits: Vec<(bool, usize, usize)> = Vec::new(); // (is_insertion, x, y) before the step
    let (mut x, mut y) = (n, m);
    for d in (1..=depth).rev() {
        let band = &trace[d as usize];
        let at = |k: isize| band[(k + d) as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && at(k - 1) < at(k + 1)) { k + 1 } else { k - 1 };
        let prev_x = at(prev_k);
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
        }
        edits.push((x == prev_x, prev_x as usize, prev_y as usize));
        (x, y) = (prev_x, prev_y);
    }
    edits.reverse();
    // Steps next to each other make one hunk.
    let mut out: Vec<Hunk> = Vec::new();
    for (insertion, x, y) in edits {
        let (old, new) = if insertion { (x..x, y..y + 1) } else { (x..x + 1, y..y) };
        match out.last_mut() {
            Some(h) if h.old.end == old.start && h.new.end == new.start => {
                h.old.end = old.end;
                h.new.end = new.end;
            }
            _ => out.push(Hunk { old, new }),
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(a: &str, b: &str, hunks: &[Hunk]) -> String {
        let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
        let mut out = a.clone();
        for h in hunks.iter().rev() {
            out.splice(h.old.clone(), b[h.new.clone()].iter().copied());
        }
        out.into_iter().collect()
    }

    #[test]
    fn the_hunks_turn_one_text_into_the_other_and_keep_what_is_alike() {
        for (a, b) in [("abc", "aXc"), ("abcabba", "cbabac"), ("", "new"), ("old", ""), ("same", "same"), ("one two three", "one 2 three four")] {
            let (ca, cb): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
            let h = hunks(&ca, &cb, 1000).unwrap();
            assert_eq!(apply(a, b, &h), b, "{a} -> {b}: {h:?}");
        }
        let (a, b): (Vec<char>, Vec<char>) = ("abc".chars().collect(), "aXc".chars().collect());
        assert_eq!(hunks(&a, &b, 1000).unwrap(), vec![Hunk { old: 1..2, new: 1..2 }]);
        // Kept between two changes: "two" stays where it is.
        let (a, b): (Vec<char>, Vec<char>) = ("one two three".chars().collect(), "1 two 3".chars().collect());
        let h = hunks(&a, &b, 1000).unwrap();
        assert_eq!(h.len(), 2, "{h:?}");
    }

    #[test]
    fn too_many_differences_give_up() {
        let a: Vec<char> = "abcdefgh".chars().collect();
        let b: Vec<char> = "stuvwxyz".chars().collect();
        assert!(hunks(&a, &b, 4).is_none());
        assert!(hunks(&a, &b, 16).is_some());
    }
}
