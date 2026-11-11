//! Text properties and overlays.
//!
//! Text properties belong to the characters: they move with the text and
//! go when it is deleted. Overlays are ranges laid over the text with
//! properties of their own; their ends move with edits as markers do. Both
//! carry things such as `face` (how text looks) and `invisible` (whether it
//! is shown).

use std::collections::BTreeMap;
use std::ops::Range;

use crate::variables::Value;

pub type Props = BTreeMap<String, Value>;

/// A stretch of text with the same properties. Runs never overlap, are kept
/// in order, and never have empty properties; text between runs has none.
#[derive(Clone, Debug, Default, PartialEq)]
struct Run {
    start: usize,
    end: usize,
    props: Props,
}

/// The properties saved with deleted text, relative to where it started, so
/// undo can put them back.
pub(crate) type SavedProps = Vec<(Range<usize>, Props)>;

/// A string with text properties, as Emacs's propertized strings: what
/// `buffer-substring` and `propertize` give, and what inserting puts back
/// with its properties. Runs are in characters from the string's start.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Text {
    pub string: String,
    pub props: Vec<(Range<usize>, Props)>,
}

impl Text {
    /// The string with `props` on all of it, as `propertize`.
    pub fn propertize(string: &str, props: Props) -> Text {
        let n = string.chars().count();
        let props = if props.is_empty() || n == 0 { Vec::new() } else { vec![(0..n, props)] };
        Text { string: string.to_string(), props }
    }

    /// This string followed by another, each keeping its properties.
    pub fn concat(mut self, other: Text) -> Text {
        let n = self.string.chars().count();
        self.string.push_str(&other.string);
        self.props.extend(other.props.into_iter().map(|(r, p)| (r.start + n..r.end + n, p)));
        self
    }

    /// The properties of the character at `i`, if it has any.
    pub fn properties_at(&self, i: usize) -> Option<&Props> {
        self.props.iter().find(|(r, _)| r.contains(&i)).map(|(_, p)| p)
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TextProperties {
    runs: Vec<Run>,
    /// Counts changes, so buffers sharing text can tell they must share them.
    pub(crate) generation: u64,
}

impl TextProperties {
    pub(crate) fn clear(&mut self) {
        self.runs.clear();
        self.generation += 1;
    }

    /// Makes room for `n` inserted characters at `pos`. Inserted text has no
    /// properties, as with Emacs's `insert`, so a run it lands inside is split.
    pub(crate) fn insert(&mut self, pos: usize, n: usize) {
        if n == 0 {
            return;
        }
        self.generation += 1;
        let mut i = self.runs.partition_point(|r| r.end <= pos);
        if let Some(run) = self.runs.get_mut(i)
            && run.start < pos
        {
            let tail = Run { start: pos, end: run.end, props: run.props.clone() };
            run.end = pos;
            self.runs.insert(i + 1, tail);
            i += 1;
        }
        for run in &mut self.runs[i..] {
            run.start += n;
            run.end += n;
        }
    }

    /// Removes the properties of deleted text and closes the gap. Returns
    /// what was removed, relative to `start`.
    pub(crate) fn delete(&mut self, start: usize, end: usize) -> SavedProps {
        self.generation += 1;
        let n = end - start;
        // Only the runs the deletion touches change; those after it move.
        let lo = self.runs.partition_point(|r| r.end <= start);
        let hi = self.runs.partition_point(|r| r.start < end);
        let mut saved = Vec::new();
        let mut kept = Vec::new();
        for run in &self.runs[lo..hi] {
            let (cut_start, cut_end) = (run.start.max(start), run.end.min(end));
            if cut_start < cut_end {
                saved.push((cut_start - start..cut_end - start, run.props.clone()));
            }
            let before = run.start.min(start)..run.end.min(start);
            let after = run.start.max(end)..run.end.max(end);
            let left = before.len() + after.len();
            if left > 0 {
                let new_start = if run.start < start { run.start } else { run.start.max(end) - n };
                kept.push(Run { start: new_start, end: new_start + left, props: run.props.clone() });
            }
        }
        for run in &mut self.runs[hi..] {
            run.start -= n;
            run.end -= n;
        }
        // What is left, between its neighbours, which it may join.
        let (from, to) = (lo.saturating_sub(1), (hi + 1).min(self.runs.len()));
        let mut window: Vec<Run> = self.runs[from..lo].iter_mut().map(std::mem::take).collect();
        window.extend(kept);
        window.extend(self.runs[hi..to].iter_mut().map(std::mem::take));
        self.runs.splice(from..to, joined(window));
        saved
    }

    /// The properties of a stretch of text, as [`TextProperties::delete`]
    /// saves them, leaving them in place.
    pub(crate) fn save(&self, start: usize, end: usize) -> SavedProps {
        // Only the runs the stretch touches, found by halving.
        let lo = self.runs.partition_point(|r| r.end <= start);
        let hi = self.runs.partition_point(|r| r.start < end).max(lo);
        self.runs[lo..hi]
            .iter()
            .filter_map(|run| {
                let (cut_start, cut_end) = (run.start.max(start), run.end.min(end));
                (cut_start < cut_end).then(|| (cut_start - start..cut_end - start, run.props.clone()))
            })
            .collect()
    }

    /// Puts back properties saved by [`TextProperties::delete`], for text
    /// re-inserted at `pos`, in one pass over the runs there however many
    /// were saved.
    pub(crate) fn restore(&mut self, pos: usize, saved: &SavedProps) {
        let in_order = saved.windows(2).all(|w| w[0].0.end <= w[1].0.start);
        if in_order {
            let edits: Vec<_> = saved
                .iter()
                .map(|(range, props)| (pos + range.start, pos + range.end, move |p: &mut Props| p.extend(props.clone())))
                .collect();
            self.apply(&edits);
        } else {
            for (range, props) in saved {
                self.modify(pos + range.start, pos + range.end, |p| p.extend(props.clone()));
            }
        }
    }

    /// Changes the properties of every character in a range.
    pub(crate) fn modify(&mut self, start: usize, end: usize, f: impl Fn(&mut Props)) {
        self.apply(&[(start, end, f)]);
    }

    /// Changes the properties of each range with its function: the ranges
    /// in order and apart. Only the runs from the first range to the last
    /// are built again, and spliced in.
    fn apply<F: Fn(&mut Props)>(&mut self, edits: &[(usize, usize, F)]) {
        let edits: Vec<&(usize, usize, F)> = edits.iter().filter(|e| e.0 < e.1).collect();
        let (Some(first), Some(last)) = (edits.first(), edits.last()) else { return };
        self.generation += 1;
        // With a neighbour on each side, which may join what is built.
        let lo = self.runs.partition_point(|r| r.end <= first.0).saturating_sub(1);
        let hi = (self.runs.partition_point(|r| r.start < last.1) + 1).min(self.runs.len());
        let mut old = self.runs[lo..hi].iter_mut().map(std::mem::take).collect::<Vec<_>>().into_iter();
        let mut out = Vec::with_capacity(hi - lo + 2 * edits.len());
        let mut cur = old.next();
        for &&(start, end, ref f) in &edits {
            // Runs, and the part of one, before the range stay as they are.
            while let Some(run) = cur.take() {
                if run.end <= start {
                    out.push(run);
                    cur = old.next();
                    continue;
                }
                if run.start < start {
                    out.push(Run { start: run.start, end: start, props: run.props.clone() });
                    cur = Some(Run { start, ..run });
                } else {
                    cur = Some(run);
                }
                break;
            }
            let mut pos = start;
            while pos < end {
                match cur.take() {
                    Some(run) if run.start < end => {
                        if run.start > pos {
                            // A gap without properties.
                            Self::push_changed(&mut out, pos, run.start, Props::new(), f);
                            pos = run.start;
                        }
                        let piece_end = run.end.min(end);
                        Self::push_changed(&mut out, pos, piece_end, run.props.clone(), f);
                        cur = if run.end > end { Some(Run { start: end, ..run }) } else { old.next() };
                        pos = piece_end;
                    }
                    other => {
                        cur = other;
                        Self::push_changed(&mut out, pos, end, Props::new(), f);
                        pos = end;
                    }
                }
            }
        }
        out.extend(cur);
        out.extend(old);
        self.runs.splice(lo..hi, joined(out));
    }

    fn push_changed(out: &mut Vec<Run>, start: usize, end: usize, mut props: Props, f: &impl Fn(&mut Props)) {
        if start < end {
            f(&mut props);
            out.push(Run { start, end, props });
        }
    }


    /// The properties of the character at `pos`.
    pub(crate) fn at(&self, pos: usize) -> Option<&Props> {
        let i = self.runs.partition_point(|r| r.end <= pos);
        self.runs.get(i).filter(|r| r.start <= pos).map(|r| &r.props)
    }

    /// The next position after `pos` where the properties change, if any.
    pub(crate) fn next_change(&self, pos: usize) -> Option<usize> {
        let i = self.runs.partition_point(|r| r.end <= pos);
        let run = self.runs.get(i)?;
        Some(if run.start > pos { run.start } else { run.end })
    }

    /// The previous position before `pos` where the properties change, if any.
    pub(crate) fn previous_change(&self, pos: usize) -> Option<usize> {
        let i = self.runs.partition_point(|r| r.start < pos);
        let run = self.runs[..i].last()?;
        Some(if run.end < pos { run.end } else { run.start })
    }
}


/// The runs without those with no properties, and neighbours with the same
/// properties joined.
fn joined(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::with_capacity(runs.len());
    for run in runs {
        if run.props.is_empty() || run.start >= run.end {
            continue;
        }
        match out.last_mut() {
            Some(last) if last.end == run.start && last.props == run.props => last.end = run.end,
            _ => out.push(run),
        }
    }
    out
}

/// A range laid over the text with properties of its own.
#[derive(Clone, Debug)]
pub struct Overlay {
    pub id: u64,
    pub start: usize,
    pub end: usize,
    pub props: Props,
    /// Whether text inserted at the start goes before the overlay rather
    /// than in it, as Emacs's `make-overlay` FRONT-ADVANCE says.
    pub front_advance: bool,
    /// Whether text inserted at the end goes in the overlay rather than
    /// after it, as REAR-ADVANCE says.
    pub rear_advance: bool,
    /// Deleted, and kept until the list is compacted.
    deleted: bool,
}

/// A buffer's overlays, in the order they were made, so ids are sorted and
/// one is found by binary search. Deleting marks an overlay and the list
/// drops marked ones once they are half of it, so deleting many, as
/// folding a large Org file does, costs no more than making them.
#[derive(Clone, Debug, Default)]
pub(crate) struct OverlayList {
    items: Vec<Overlay>,
    deleted: usize,
    /// Whether an overlay has had a hook property put, so an edit must
    /// look for hooks to call: most overlays, as Org's folds, have none.
    pub(crate) hooks: bool,
    /// Where overlays are, built when first asked after a change.
    index: std::cell::RefCell<Option<std::rc::Rc<OverlayIndex>>>,
}

/// Overlays by position: the positions where one starts or ends, sorted,
/// with the overlays at each, and for each stretch between two such
/// positions the overlays covering it. Redisplay asks what covers a
/// position and where the next change is at every step, which this
/// answers by binary search instead of a pass over every overlay.
#[derive(Debug, Default)]
pub(crate) struct OverlayIndex {
    /// How many of the list's entries it covers; those made since are
    /// checked one by one until there are enough to build it again.
    built: usize,
    /// Each edge, sorted, with the overlay (an index into the list) that
    /// starts or ends there.
    edges: Vec<(usize, u32)>,
    /// The distinct edges, sorted; stretch `k` runs from `bounds[k]` to
    /// `bounds[k + 1]`.
    bounds: Vec<usize>,
    /// The overlays covering each stretch: `covering[spans[k]..spans[k + 1]]`.
    spans: Vec<u32>,
    covering: Vec<u32>,
}

/// Past this many covering entries, as with thousands of nested overlays,
/// the index keeps no stretches and covering positions are found by a pass.
const MAX_COVERING: usize = 1 << 20;

impl OverlayIndex {
    fn build(items: &[Overlay]) -> OverlayIndex {
        let mut edges: Vec<(usize, u32)> = Vec::with_capacity(items.len() * 2);
        for (i, o) in items.iter().enumerate().filter(|(_, o)| !o.deleted) {
            edges.push((o.start, i as u32));
            if o.end != o.start {
                edges.push((o.end, i as u32));
            }
        }
        edges.sort_unstable();
        let mut bounds: Vec<usize> = edges.iter().map(|e| e.0).collect();
        bounds.dedup();
        // Sweep the edges: at each bound, those starting join and those
        // ending leave the overlays covering the stretch after it.
        let mut active: Vec<u32> = Vec::new();
        let mut spans = Vec::with_capacity(bounds.len() + 1);
        let mut covering = Vec::new();
        let mut e = 0;
        for &b in &bounds {
            while e < edges.len() && edges[e].0 == b {
                let i = edges[e].1;
                let o = &items[i as usize];
                if o.end == b {
                    active.retain(|&a| a != i);
                } else if o.start == b {
                    active.push(i);
                }
                e += 1;
            }
            spans.push(covering.len() as u32);
            covering.extend_from_slice(&active);
            if covering.len() > MAX_COVERING {
                return OverlayIndex { built: items.len(), edges, bounds, spans: Vec::new(), covering: Vec::new() };
            }
        }
        spans.push(covering.len() as u32);
        OverlayIndex { built: items.len(), edges, bounds, spans, covering }
    }

    /// The overlays covering `pos` (start <= pos < end), as indices, or
    /// `None` when the index keeps no stretches.
    fn covering(&self, pos: usize) -> Option<&[u32]> {
        if self.spans.is_empty() && !self.bounds.is_empty() {
            return None;
        }
        // The last bound at or before pos.
        let k = match self.bounds.partition_point(|&b| b <= pos) {
            0 => return Some(&[]),
            k => k - 1,
        };
        Some(&self.covering[self.spans[k] as usize..self.spans[k + 1] as usize])
    }

    /// The overlays starting or ending at `pos`.
    fn at_edge(&self, pos: usize) -> &[(usize, u32)] {
        let from = self.edges.partition_point(|e| e.0 < pos);
        let to = self.edges.partition_point(|e| e.0 <= pos);
        &self.edges[from..to]
    }

}

impl OverlayList {
    pub(crate) fn push(&mut self, overlay: Overlay) {
        debug_assert!(self.items.last().is_none_or(|o| o.id < overlay.id));
        self.items.push(overlay);
    }

    /// The index, built again when overlays made since it was built are
    /// an eighth of it, so making many costs O(n log n) in all.
    fn spatial(&self) -> std::rc::Rc<OverlayIndex> {
        let mut index = self.index.borrow_mut();
        if let Some(i) = index.as_ref()
            && self.items.len() - i.built > (i.built / 8).max(64)
        {
            *index = None;
        }
        index.get_or_insert_with(|| std::rc::Rc::new(OverlayIndex::build(&self.items))).clone()
    }

    /// Overlays made since the index was built, with their indices.
    fn newer<'a>(&'a self, index: &OverlayIndex) -> impl Iterator<Item = (u32, &'a Overlay)> + 'a {
        let built = index.built;
        self.items[built..].iter().enumerate().filter(|(_, o)| !o.deleted).map(move |(k, o)| ((built + k) as u32, o))
    }

    fn live(&self, i: u32) -> Option<&Overlay> {
        Some(&self.items[i as usize]).filter(|o| !o.deleted)
    }

    fn changed(&mut self) {
        *self.index.get_mut() = None;
    }

    /// The overlays covering `pos`: those with start <= pos < end.
    pub(crate) fn covering(&self, pos: usize) -> Vec<&Overlay> {
        let index = self.spatial();
        let mut found: Vec<&Overlay> = match index.covering(pos) {
            Some(found) => found.iter().filter_map(|&i| self.live(i)).collect(),
            None => self.items[..index.built].iter().filter(|o| !o.deleted && o.start <= pos && pos < o.end).collect(),
        };
        found.extend(self.newer(&index).map(|(_, o)| o).filter(|o| o.start <= pos && pos < o.end));
        found
    }

    /// The overlays starting or ending at `pos`, each once, in the order made.
    pub(crate) fn at_edge(&self, pos: usize) -> Vec<&Overlay> {
        let index = self.spatial();
        let mut found: Vec<u32> = index.at_edge(pos).iter().map(|e| e.1).collect();
        found.extend(self.newer(&index).filter(|(_, o)| o.start == pos || o.end == pos).map(|(i, _)| i));
        found.sort_unstable();
        found.dedup();
        found.into_iter().filter_map(|i| self.live(i)).collect()
    }

    /// The overlays overlapping `start..end`, and empty ones at or inside
    /// it, as Emacs's `overlays-in` finds them, in the order made.
    pub(crate) fn overlapping(&self, start: usize, end: usize) -> Vec<&Overlay> {
        let overlaps = |o: &Overlay| (o.start < end && o.end > start) || (o.start == o.end && o.start >= start && o.start <= end);
        let index = self.spatial();
        let mut found: Vec<u32> = match index.covering(start) {
            Some(covering) => {
                let mut found: Vec<u32> = covering.iter().copied().filter(|&i| self.items[i as usize].start < end).collect();
                let from = index.edges.partition_point(|e| e.0 < start);
                for &(pos, i) in index.edges[from..].iter().take_while(|e| e.0 <= end) {
                    let o = &self.items[i as usize];
                    if (o.start == pos && pos > start && pos < end) || (o.start == o.end && pos >= start) {
                        found.push(i);
                    }
                }
                found
            }
            None => (0..index.built as u32).filter(|&i| overlaps(&self.items[i as usize])).collect(),
        };
        found.extend(self.newer(&index).filter(|(_, o)| overlaps(o)).map(|(i, _)| i));
        found.sort_unstable();
        found.dedup();
        found.into_iter().filter_map(|i| self.live(i)).collect()
    }

    /// The first position after `pos` where an overlay starts or ends.
    pub(crate) fn next_edge(&self, pos: usize) -> Option<usize> {
        let index = self.spatial();
        let from = index.edges.partition_point(|e| e.0 <= pos);
        let indexed = index.edges[from..].iter().find(|e| !self.items[e.1 as usize].deleted).map(|e| e.0);
        let newer = self.newer(&index).flat_map(|(_, o)| [o.start, o.end]).filter(|&e| e > pos).min();
        match (indexed, newer) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// The last position before `pos` where an overlay starts or ends.
    pub(crate) fn previous_edge(&self, pos: usize) -> Option<usize> {
        let index = self.spatial();
        let to = index.edges.partition_point(|e| e.0 < pos);
        let indexed = index.edges[..to].iter().rev().find(|e| !self.items[e.1 as usize].deleted).map(|e| e.0);
        let newer = self.newer(&index).flat_map(|(_, o)| [o.start, o.end]).filter(|&e| e < pos).max();
        indexed.max(newer)
    }

    fn index(&self, id: u64) -> Option<usize> {
        self.items.binary_search_by_key(&id, |o| o.id).ok().filter(|&i| !self.items[i].deleted)
    }

    pub(crate) fn get(&self, id: u64) -> Option<&Overlay> {
        self.index(id).map(|i| &self.items[i])
    }

    /// An overlay to move: the index is built again after.
    pub(crate) fn get_mut(&mut self, id: u64) -> Option<&mut Overlay> {
        self.changed();
        self.index(id).map(|i| &mut self.items[i])
    }

    /// An overlay's properties, which the index does not depend on.
    pub(crate) fn props_mut(&mut self, id: u64) -> Option<&mut Props> {
        self.index(id).map(|i| &mut self.items[i].props)
    }

    pub(crate) fn remove(&mut self, id: u64) {
        if let Some(i) = self.index(id) {
            self.items[i].deleted = true;
            self.items[i].props.clear();
            self.deleted += 1;
            if self.deleted > 32 && self.deleted * 2 > self.items.len() {
                self.changed();
                self.items.retain(|o| !o.deleted);
                self.deleted = 0;
            }
        }
    }

    pub(crate) fn iter(&self) -> impl DoubleEndedIterator<Item = &Overlay> + Clone {
        self.items.iter().filter(|o| !o.deleted)
    }

    pub(crate) fn iter_mut(&mut self) -> impl Iterator<Item = &mut Overlay> {
        self.changed();
        self.items.iter_mut().filter(|o| !o.deleted)
    }

    pub(crate) fn retain(&mut self, keep: impl Fn(&Overlay) -> bool) {
        self.changed();
        self.items.retain(|o| !o.deleted && keep(o));
        self.deleted = 0;
    }

    pub(crate) fn clear(&mut self) {
        self.changed();
        self.items.clear();
        self.deleted = 0;
        self.hooks = false;
    }

    /// Puts an overlay back as it was, in its place by id, whether it is
    /// still there, was deleted, or is gone.
    pub(crate) fn restore(&mut self, overlay: Overlay) {
        self.changed();
        match self.items.binary_search_by_key(&overlay.id, |o| o.id) {
            Ok(i) => {
                if self.items[i].deleted {
                    self.deleted -= 1;
                }
                self.items[i] = overlay;
            }
            Err(i) => self.items.insert(i, overlay),
        }
    }
}

impl Overlay {
    pub(crate) fn new(id: u64, start: usize, end: usize) -> Overlay {
        Overlay { id, start, end, props: Props::new(), front_advance: false, rear_advance: false, deleted: false }
    }

    /// Moves the overlay's ends for an insertion, as Emacs moves overlay
    /// markers: by default, text inserted at the start goes inside the
    /// overlay, and text inserted at the end goes after it. Inserting before
    /// markers moves both ends past the text, as insert-before-markers does.
    pub(crate) fn insert(&mut self, pos: usize, n: usize, before_markers: bool) {
        if self.start > pos || (self.start == pos && (self.front_advance || before_markers)) {
            self.start += n;
        }
        if self.end > pos || (self.end == pos && (self.rear_advance || before_markers)) {
            self.end += n;
        }
        if self.end < self.start {
            self.end = self.start;
        }
    }

    pub(crate) fn delete(&mut self, start: usize, end: usize) {
        let shift = |p: usize| if p >= end { p - (end - start) } else { p.min(start) };
        self.start = shift(self.start);
        self.end = shift(self.end);
    }

    /// Overlays with an `evaporate` property go away when they become empty.
    pub(crate) fn evaporates(&self) -> bool {
        self.start == self.end && self.props.get("evaporate").is_some_and(|v| v.is_true())
    }

    /// Higher priorities win when overlays disagree, as Emacs's `priority` property.
    pub fn priority(&self) -> f64 {
        self.props.get("priority").and_then(|v| v.as_number()).unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(name: &str) -> impl Fn(&mut Props) {
        let name = name.to_string();
        move |p: &mut Props| {
            p.insert("face".into(), Value::Str(name.clone()));
        }
    }

    fn runs(t: &TextProperties) -> Vec<(usize, usize, String)> {
        t.runs
            .iter()
            .map(|r| (r.start, r.end, r.props.get("face").map(|v| v.to_string()).unwrap_or_default()))
            .collect()
    }

    #[test]
    fn put_splits_and_joins_runs() {
        let mut t = TextProperties::default();
        t.modify(2, 8, face("bold"));
        t.modify(4, 6, face("italic"));
        assert_eq!(runs(&t), [(2, 4, "\"bold\"".into()), (4, 6, "\"italic\"".into()), (6, 8, "\"bold\"".into())]);
        t.modify(0, 10, face("bold"));
        assert_eq!(runs(&t), [(0, 10, "\"bold\"".into())]);
        t.modify(3, 5, |p| {
            p.remove("face");
        });
        assert_eq!(runs(&t), [(0, 3, "\"bold\"".into()), (5, 10, "\"bold\"".into())]);
    }

    #[test]
    fn properties_move_with_edits() {
        let mut t = TextProperties::default();
        t.modify(2, 6, face("bold"));
        t.insert(4, 3);
        assert_eq!(runs(&t), [(2, 4, "\"bold\"".into()), (7, 9, "\"bold\"".into())]);
        t.insert(0, 1);
        assert_eq!(runs(&t)[0].0, 3);
        // Deleting the plain text between the two runs joins them.
        let saved = t.delete(4, 8);
        assert_eq!(runs(&t), [(3, 6, "\"bold\"".into())]);
        assert_eq!(saved.len(), 1);
        // Undo puts the deleted text back with its properties.
        t.insert(4, 4);
        t.restore(4, &saved);
        assert_eq!(runs(&t), [(3, 5, "\"bold\"".into()), (8, 10, "\"bold\"".into())]);
        assert_eq!(t.next_change(0), Some(3));
        assert_eq!(t.next_change(3), Some(5));
        assert_eq!(t.previous_change(10), Some(8));
        assert_eq!(t.previous_change(7), Some(5));
    }

    /// The runs agree with a list of each character's properties, after
    /// random insertions, deletions, changes and restorations, and stay
    /// in order, apart, never empty and never alike side by side.
    #[test]
    fn runs_agree_with_a_property_list_per_character() {
        let mut seed = 11u64;
        let mut rand = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize % n.max(1)
        };
        let faces = ["a", "b", "c"];
        let mut t = TextProperties::default();
        let mut model: Vec<Props> = vec![Props::new(); 50];
        for _ in 0..3000 {
            let len = model.len();
            let (x, y) = (rand(len + 1), rand(len + 1));
            let (start, end) = (x.min(y), x.max(y));
            match rand(5) {
                0 => {
                    let n = rand(5) + 1;
                    t.insert(start, n);
                    model.splice(start..start, std::iter::repeat_n(Props::new(), n));
                }
                1 => {
                    let saved = t.delete(start, end);
                    let gone: Vec<Props> = model.drain(start..end).collect();
                    // Undoing the deletion puts it back with its properties.
                    if rand(2) == 0 {
                        t.insert(start, end - start);
                        t.restore(start, &saved);
                        model.splice(start..start, gone);
                    }
                }
                2 => {
                    let f = face(faces[rand(3)]);
                    t.modify(start, end, &f);
                    model[start..end].iter_mut().for_each(&f);
                }
                3 => {
                    t.modify(start, end, |p| {
                        p.remove("face");
                    });
                    model[start..end].iter_mut().for_each(|p| {
                        p.remove("face");
                    });
                }
                _ => {
                    // Restoring over text with properties merges them.
                    let saved = t.save(start, end);
                    let to = rand(len.saturating_sub(end - start) + 1);
                    t.restore(to, &saved);
                    let copied: Vec<Props> = model[start..end].to_vec();
                    for (k, p) in copied.into_iter().enumerate() {
                        model[to + k].extend(p);
                    }
                }
            }
            for (pos, props) in model.iter().enumerate() {
                assert_eq!(t.at(pos).cloned().unwrap_or_default(), *props, "at {pos}");
            }
            for w in t.runs.windows(2) {
                assert!(w[0].end <= w[1].start && !(w[0].end == w[1].start && w[0].props == w[1].props), "{:?}", t.runs);
            }
            assert!(t.runs.iter().all(|r| r.start < r.end && !r.props.is_empty() && r.end <= model.len()));
        }
    }

    #[test]
    fn overlays_follow_edits() {
        let mut o = Overlay::new(1, 2, 5);
        o.insert(2, 1, false); // at the start: goes inside
        assert_eq!((o.start, o.end), (2, 6));
        o.insert(6, 1, false); // at the end: goes after
        assert_eq!((o.start, o.end), (2, 6));
        o.delete(0, 3);
        assert_eq!((o.start, o.end), (0, 3));
    }
}

#[cfg(test)]
mod overlay_index_tests {
    use super::*;

    /// The index answers as a pass over every overlay does, after making,
    /// moving and deleting them.
    #[test]
    fn the_index_agrees_with_a_pass_over_every_overlay() {
        let mut list = OverlayList::default();
        let mut seed = 7u64;
        let mut rand = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize % n
        };
        for id in 1..=300u64 {
            let start = rand(200);
            let end = start + rand(30) * (rand(4).min(1));
            list.push(Overlay::new(id, start, end));
        }
        for _ in 0..100 {
            let id = rand(300) as u64 + 1;
            match rand(8) {
                0 => {
                    if let Some(o) = list.get_mut(id) {
                        o.start = o.start.saturating_sub(3);
                    }
                }
                1 | 2 => {
                    let next = list.items.last().map_or(1, |o| o.id + 1);
                    let start = rand(200);
                    list.push(Overlay::new(next, start, start + rand(10)));
                }
                _ => list.remove(id),
            }
            for pos in [rand(240), rand(240), 0, 199] {
                let ids = |v: Vec<&Overlay>| { let mut v: Vec<u64> = v.iter().map(|o| o.id).collect(); v.sort(); v };
                assert_eq!(ids(list.covering(pos)), ids(list.iter().filter(|o| o.start <= pos && pos < o.end).collect()));
                assert_eq!(ids(list.at_edge(pos)), ids(list.iter().filter(|o| o.start == pos || o.end == pos).collect()));
                let next = list.iter().flat_map(|o| [o.start, o.end]).filter(|&e| e > pos).min();
                assert_eq!(list.next_edge(pos), next);
                let previous = list.iter().flat_map(|o| [o.start, o.end]).filter(|&e| e < pos).max();
                assert_eq!(list.previous_edge(pos), previous);
                let end = pos + rand(20);
                let overlapping = list.iter().filter(|o| (o.start < end && o.end > pos) || (o.start == o.end && o.start >= pos && o.start <= end)).collect();
                assert_eq!(ids(list.overlapping(pos, end)), ids(overlapping));
            }
        }
    }
}
