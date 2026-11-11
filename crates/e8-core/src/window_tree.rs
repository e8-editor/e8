//! A frame's windows as window.c keeps them: a tree whose leaves are the
//! live windows and whose other nodes are internal windows, each a
//! combination of two or more child windows side by side or one above
//! another (ADR 0069, stage 3). Every child has a total size, in lines or
//! columns along its combination, its mode line and divider included;
//! across the combination it takes the combination's size.
//!
//! Splitting a window whose parent is a combination of the same kind makes
//! the new window a sibling, as Emacs does unless a combination limit says
//! otherwise; deleting a window gives its space to a sibling, and an
//! internal window left with one child is replaced by it, its children
//! joining their grandparent's combination when it is of their kind.
//!
//! The tree goes to front ends in the frame description, so it holds no
//! script values: an internal window's parameters are the editor's.

use crate::window::WindowId;

/// The smallest window that can be made by splitting, counting its mode
/// line, as Emacs's `window-min-height` and `window-min-width`.
pub(crate) const WINDOW_MIN_HEIGHT: usize = 4;
pub(crate) const WINDOW_MIN_WIDTH: usize = 10;

/// How the frame is divided: a live window, or an internal window
/// combining others.
#[derive(Clone, Debug, PartialEq)]
pub enum WindowTree {
    Leaf(WindowId),
    Combination(Combination),
}

/// An internal window: two or more children side by side or one above
/// another.
#[derive(Clone, Debug, PartialEq)]
pub struct Combination {
    pub id: WindowId,
    /// Side by side, a horizontal combination as `C-x 3` makes, rather than
    /// one above another.
    pub horizontal: bool,
    pub children: Vec<Part>,
    /// Whether splitting a child always makes a new internal window, as
    /// `set-window-combination-limit` sets it.
    pub limit: bool,
}

/// A child of a combination: its total size along the combination, and
/// its normal size, its share of the combination, as Emacs's
/// `window-normal-size`, which a new frame size is shared by, so sizes
/// come back when the frame does.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub tree: WindowTree,
    pub size: usize,
    pub normal: f64,
}

/// Where a window goes, in whatever units a front end lays out in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowRect {
    pub id: WindowId,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Whether a window lies to the right, so a divider goes on this one's right edge.
    pub divider: bool,
}

/// How splitting goes: which window is split, the new window's id and the
/// id an internal window takes if one is made, the kind of split, whether
/// the new window goes before, and the two sizes, along the split.
pub(crate) struct Split {
    pub target: WindowId,
    pub new: WindowId,
    pub internal: WindowId,
    pub horizontal: bool,
    pub before: bool,
    pub old_size: usize,
    pub new_size: usize,
    /// Whether a new internal window is made whatever the parent, as
    /// `window-combination-limit` t says; the new one keeps it as its
    /// combination limit.
    pub limit: bool,
}

impl WindowTree {
    /// This node's id: a live window's, or an internal window's.
    pub fn id(&self) -> WindowId {
        match self {
            WindowTree::Leaf(id) => *id,
            WindowTree::Combination(c) => c.id,
        }
    }

    /// The live windows in cyclic order, as `other-window` visits them:
    /// left to right and top to bottom.
    pub fn leaves(&self) -> Vec<WindowId> {
        let mut out = Vec::new();
        self.leaves_into(&mut out);
        out
    }

    fn leaves_into(&self, out: &mut Vec<WindowId>) {
        match self {
            WindowTree::Leaf(id) => out.push(*id),
            WindowTree::Combination(c) => c.children.iter().for_each(|p| p.tree.leaves_into(out)),
        }
    }

    /// Every window, live and internal, parents before their children.
    pub fn ids(&self) -> Vec<WindowId> {
        let mut out = vec![self.id()];
        if let WindowTree::Combination(c) = self {
            for p in &c.children {
                out.extend(p.tree.ids());
            }
        }
        out
    }

    /// Whether a window, live or internal, is in this tree.
    pub fn contains(&self, id: WindowId) -> bool {
        self.path(id).is_some()
    }

    /// The child indices from here down to a window.
    pub(crate) fn path(&self, id: WindowId) -> Option<Vec<usize>> {
        if self.id() == id {
            return Some(Vec::new());
        }
        let WindowTree::Combination(c) = self else { return None };
        c.children.iter().enumerate().find_map(|(i, p)| {
            p.tree.path(id).map(|mut rest| {
                rest.insert(0, i);
                rest
            })
        })
    }

    pub fn node(&self, id: WindowId) -> Option<&WindowTree> {
        let path = self.path(id)?;
        let mut node = self;
        for i in path {
            let WindowTree::Combination(c) = node else { unreachable!("a path goes through combinations") };
            node = &c.children[i].tree;
        }
        Some(node)
    }

    fn at_mut(&mut self, path: &[usize]) -> &mut WindowTree {
        let mut node = self;
        for &i in path {
            let WindowTree::Combination(c) = node else { unreachable!("a path goes through combinations") };
            node = &mut c.children[i].tree;
        }
        node
    }

    fn combination_mut(&mut self, path: &[usize]) -> &mut Combination {
        match self.at_mut(path) {
            WindowTree::Combination(c) => c,
            WindowTree::Leaf(_) => unreachable!("a parent is a combination"),
        }
    }

    /// An internal window, for its children and combination limit.
    pub fn combination_of(&self, id: WindowId) -> Option<&Combination> {
        match self.node(id)? {
            WindowTree::Combination(c) => Some(c),
            WindowTree::Leaf(_) => None,
        }
    }

    pub(crate) fn combination_by_id_mut(&mut self, id: WindowId) -> Option<&mut Combination> {
        let path = self.path(id)?;
        match self.at_mut(&path) {
            WindowTree::Combination(c) => Some(c),
            WindowTree::Leaf(_) => None,
        }
    }

    /// A window's parent, the internal window it is a child of, and its
    /// place among its siblings.
    pub fn parent(&self, id: WindowId) -> Option<(&Combination, usize)> {
        let path = self.path(id)?;
        let (&last, up) = path.split_last()?;
        let mut node = self;
        for &i in up {
            let WindowTree::Combination(c) = node else { unreachable!() };
            node = &c.children[i].tree;
        }
        match node {
            WindowTree::Combination(c) => Some((c, last)),
            WindowTree::Leaf(_) => None,
        }
    }

    /// A window's size in lines and columns, total, when this tree fills
    /// `extent`, as the sizes along each combination give it.
    pub fn extent_of(&self, id: WindowId, extent: (usize, usize)) -> Option<(usize, usize)> {
        let path = self.path(id)?;
        let (mut node, mut extent) = (self, extent);
        for i in path {
            let WindowTree::Combination(c) = node else { unreachable!() };
            let size = c.children[i].size;
            extent = if c.horizontal { (size, extent.1) } else { (extent.0, size) };
            node = &c.children[i].tree;
        }
        Some(extent)
    }

    /// Divides a rectangle among the live windows. Sizes are rounded to
    /// whole units, so cells for a terminal and points for a window both
    /// work. `cell` is a column's width and a line's height, in which the
    /// sizes are counted; a rectangle that is not as many cells as the sizes
    /// add up to is shared in their proportions.
    pub fn rects(&self, x: f32, y: f32, width: f32, height: f32, cell: (f32, f32)) -> Vec<WindowRect> {
        let mut out = Vec::new();
        self.rects_into(x, y, width, height, cell, false, &mut out, false);
        out
    }

    /// The rectangles of every window, internal ones too, parents first.
    pub fn all_rects(&self, x: f32, y: f32, width: f32, height: f32, cell: (f32, f32)) -> Vec<WindowRect> {
        let mut out = Vec::new();
        self.rects_into(x, y, width, height, cell, false, &mut out, true);
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn rects_into(&self, x: f32, y: f32, w: f32, h: f32, cell: (f32, f32), divider: bool, out: &mut Vec<WindowRect>, internal: bool) {
        match self {
            WindowTree::Leaf(id) => out.push(WindowRect { id: *id, x, y, width: w, height: h, divider }),
            WindowTree::Combination(c) => {
                if internal {
                    out.push(WindowRect { id: c.id, x, y, width: w, height: h, divider });
                }
                let (along, unit) = if c.horizontal { (w, cell.0) } else { (h, cell.1) };
                let edges = share(c.children.iter().map(|p| p.size), along, unit);
                let last = c.children.len() - 1;
                for (i, p) in c.children.iter().enumerate() {
                    let (start, end) = (edges[i], edges[i + 1]);
                    if c.horizontal {
                        p.tree.rects_into(x + start, y, end - start, h, cell, if i < last { true } else { divider }, out, internal);
                    } else {
                        p.tree.rects_into(x, y + start, w, end - start, cell, divider, out, internal);
                    }
                }
            }
        }
    }

    /// The smallest a part of the tree can be across or down, as Emacs's
    /// `window-min-width` and `window-min-height` allow for each window.
    pub(crate) fn min_size(&self, horizontal: bool) -> usize {
        match self {
            WindowTree::Leaf(_) => {
                if horizontal {
                    WINDOW_MIN_WIDTH
                } else {
                    WINDOW_MIN_HEIGHT
                }
            }
            WindowTree::Combination(c) => {
                let sizes = c.children.iter().map(|p| p.tree.min_size(horizontal));
                if c.horizontal == horizontal { sizes.sum() } else { sizes.max().unwrap_or(0) }
            }
        }
    }

    /// Makes each combination's sizes add up to its extent, sharing a
    /// change in their proportions, as Emacs's normal sizes share a
    /// frame's new size among its windows.
    pub(crate) fn fit(&mut self, extent: (usize, usize)) {
        let WindowTree::Combination(c) = self else { return };
        let along = if c.horizontal { extent.0 } else { extent.1 };
        let total: usize = c.children.iter().map(|p| p.size).sum();
        if total != along {
            let sizes = proportional(c.children.iter().map(|p| p.normal).collect(), along);
            for (p, size) in c.children.iter_mut().zip(sizes) {
                p.size = size;
            }
        }
        for p in &mut c.children {
            let child = if c.horizontal { (p.size, extent.1) } else { (extent.0, p.size) };
            p.tree.fit(child);
        }
    }

    /// Splits a window, live or internal, as Emacs's `split-window`: the
    /// new window becomes its sibling if its parent combines windows the
    /// same way, else a new internal window takes its place, combining it
    /// and the new one. Says whether that internal window was made; false
    /// with no change if the window is not here.
    pub(crate) fn split(&mut self, s: &Split) -> Option<bool> {
        let path = self.path(s.target)?;
        let new = Part { tree: WindowTree::Leaf(s.new), size: s.new_size, normal: 0.0 };
        if !self.split_makes_parent(s.target, s.horizontal, s.limit) {
            let (&i, up) = path.split_last().expect("a window with a parent");
            let parent = self.combination_mut(up);
            parent.children[i].size = s.old_size;
            parent.children.insert(if s.before { i } else { i + 1 }, new);
            renormalize(parent);
            return Some(false);
        }
        let node = self.at_mut(&path);
        let old = Part { tree: std::mem::replace(node, WindowTree::Leaf(s.target)), size: s.old_size, normal: 0.0 };
        let children = if s.before { vec![new, old] } else { vec![old, new] };
        let mut c = Combination { id: s.internal, horizontal: s.horizontal, children, limit: s.limit };
        renormalize(&mut c);
        *node = WindowTree::Combination(c);
        Some(true)
    }

    /// Whether splitting a window makes a new internal window rather than
    /// a sibling: unless its parent combines windows the same way and the
    /// combination limit is off. A parent's own limit only keeps it from
    /// being merged away, as in Emacs.
    pub(crate) fn split_makes_parent(&self, target: WindowId, horizontal: bool, limit: bool) -> bool {
        limit || !matches!(self.parent(target), Some((p, _)) if p.horizontal == horizontal)
    }

    /// Removes a live window, giving its space to the sibling before it, or
    /// after it if it is the first, as Emacs's `delete-window` does. Gives
    /// the internal windows that went, as one left with a single child is
    /// replaced by it.
    pub(crate) fn remove(&mut self, id: WindowId) -> Vec<WindowId> {
        let Some(path) = self.path(id) else { return Vec::new() };
        let Some((&i, up)) = path.split_last() else { return Vec::new() };
        let up = up.to_vec();
        let parent = self.combination_mut(&up);
        let size = parent.children.remove(i).size;
        let to = if i > 0 { i - 1 } else { 0 };
        parent.children[to].size += size;
        renormalize(parent);
        if parent.children.len() > 1 {
            return Vec::new();
        }
        // One child left: it takes its parent's place.
        let gone = parent.id;
        let only = parent.children.pop().expect("one child").tree;
        let node = self.at_mut(&up);
        *node = only;
        // Its children join their grandparent's combination if it is of their kind.
        if let Some((&k, top)) = up.split_last() {
            let top = top.to_vec();
            let grand = self.combination_mut(&top);
            if let WindowTree::Combination(child) = &grand.children[k].tree
                && child.horizontal == grand.horizontal
                && !child.limit
            {
                let WindowTree::Combination(child) = grand.children.remove(k).tree else { unreachable!() };
                for (j, p) in child.children.into_iter().enumerate() {
                    grand.children.insert(k + j, p);
                }
                renormalize(grand);
                return vec![gone, child.id];
            }
        }
        vec![gone]
    }

    /// Grows or shrinks a window by up to `delta` lines or columns, taking
    /// them from or giving them to a sibling in the nearest combination of
    /// that kind above it, as Emacs's `window-resize` with its defaults:
    /// the sibling after it, or before it if it is the last. `extent` is
    /// the tree's size in cells; with `apply` off, only works out how far
    /// it could go. With `edge`, only an edge below or to the right of the
    /// window moves, as dragging its mode line or divider moves it, from
    /// the nearest combination where one is. Gives how far it went, or
    /// None if no combination of that kind is above it.
    pub(crate) fn resize(&mut self, id: WindowId, delta: i64, horizontal: bool, extent: (usize, usize), apply: bool, edge: bool) -> Option<i64> {
        let path = self.path(id)?;
        // The nearest combination of that kind with a sibling to take from.
        let (depth, k, n) = (0..path.len()).rev().find_map(|depth| {
            let up = &path[..depth];
            let WindowTree::Combination(c) = self.node_at(up) else { unreachable!() };
            if c.horizontal != horizontal {
                return None;
            }
            let k = path[depth];
            let n = if k + 1 < c.children.len() {
                k + 1
            } else if edge || k == 0 {
                return None;
            } else {
                k - 1
            };
            Some((depth, k, n))
        })?;
        let up = path[..depth].to_vec();
        let c = self.combination_mut(&up);
        let size = c.children[k].size as i64;
        let other = c.children[n].size as i64;
        let lowest = c.children[k].tree.min_size(horizontal) as i64;
        let highest = size + other - c.children[n].tree.min_size(horizontal) as i64;
        let moved = (size + delta).clamp(lowest.min(size), highest.max(size));
        if apply {
            c.children[k].size = moved as usize;
            c.children[n].size = (other - (moved - size)) as usize;
            renormalize(c);
            self.fit(extent);
        }
        Some(moved - size)
    }

    fn node_at(&self, path: &[usize]) -> &WindowTree {
        let mut node = self;
        for &i in path {
            let WindowTree::Combination(c) = node else { unreachable!() };
            node = &c.children[i].tree;
        }
        node
    }

    /// Gives each combination's children the same share of it, the first
    /// ones a line or column more where it does not divide evenly, as
    /// Emacs's `balance-windows`.
    pub(crate) fn balance(&mut self, extent: (usize, usize)) {
        let WindowTree::Combination(c) = self else { return };
        let along = if c.horizontal { extent.0 } else { extent.1 };
        let n = c.children.len();
        for (i, p) in c.children.iter_mut().enumerate() {
            p.size = along / n + usize::from(i < along % n);
            let child = if c.horizontal { (p.size, extent.1) } else { (extent.0, p.size) };
            p.tree.balance(child);
        }
        renormalize(c);
    }

    /// Whether a window shares the frame's width with others, as Emacs's
    /// `window-full-width-p` is false for it.
    pub(crate) fn is_partial_width(&self, id: WindowId) -> bool {
        let Some(path) = self.path(id) else { return false };
        let mut node = self;
        for i in path {
            let WindowTree::Combination(c) = node else { unreachable!() };
            if c.horizontal {
                return true;
            }
            node = &c.children[i].tree;
        }
        false
    }

    /// The smallest part of the tree holding all of `ids`.
    pub(crate) fn enclosing(&self, ids: &[WindowId]) -> Option<WindowId> {
        let paths: Vec<Vec<usize>> = ids.iter().map(|&id| self.path(id)).collect::<Option<_>>()?;
        let first = paths.first()?;
        let common = (0..first.len()).take_while(|&d| paths.iter().all(|p| p.len() > d && p[d] == first[d])).count();
        Some(self.node_at(&first[..common]).id())
    }
}

/// Where each of some children starts along `along`, and the end, for
/// sizes in cells of `unit`: their sizes when they add up to `along`, else
/// shared in their proportions, rounded to whole units.
fn share(sizes: impl Iterator<Item = usize>, along: f32, unit: f32) -> Vec<f32> {
    let sizes: Vec<usize> = sizes.collect();
    let total: usize = sizes.iter().sum();
    let exact = ((total as f32) * unit - along).abs() < unit;
    let mut edges = vec![0.0];
    let mut sum = 0usize;
    for (i, &size) in sizes.iter().enumerate() {
        sum += size;
        let edge = if i + 1 == sizes.len() {
            along
        } else if exact {
            (sum as f32 * unit).round().min(along)
        } else if total == 0 {
            (along * (i + 1) as f32 / sizes.len() as f32).round()
        } else {
            ((sum as f32 / total as f32 * along) / unit).round() * unit
        };
        edges.push(edge);
    }
    edges
}

/// Gives a combination's children their normal sizes, their shares of it.
fn renormalize(c: &mut Combination) {
    let total: usize = c.children.iter().map(|p| p.size).sum();
    let n = c.children.len();
    for p in &mut c.children {
        p.normal = if total == 0 { 1.0 / n as f64 } else { p.size as f64 / total as f64 };
    }
}

/// Sizes in the proportions of `normals`, adding up to `total`: each its
/// share rounded down, what is left one each to the largest remainders,
/// earlier ones first, and none less than one while there is room.
fn proportional(normals: Vec<f64>, total: usize) -> Vec<usize> {
    let n = normals.len();
    let sum: f64 = normals.iter().sum();
    if n == 0 {
        return Vec::new();
    }
    let shares: Vec<f64> = normals.iter().map(|w| if sum > 0.0 { w / sum * total as f64 } else { total as f64 / n as f64 }).collect();
    let mut out: Vec<usize> = shares.iter().map(|s| s.floor() as usize).collect();
    let mut left = total.saturating_sub(out.iter().sum::<usize>());
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| (shares[b] - shares[b].floor()).total_cmp(&(shares[a] - shares[a].floor())).then(a.cmp(&b)));
    for i in order {
        if left == 0 {
            break;
        }
        out[i] += 1;
        left -= 1;
    }
    // A window never shrinks to nothing while another can give it a line.
    for i in 0..n {
        while out[i] == 0 {
            let Some(j) = (0..n).filter(|&j| out[j] > 1).max_by_key(|&j| out[j]) else { break };
            out[j] -= 1;
            out[i] += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(tree: &mut WindowTree, target: WindowId, new: WindowId, internal: WindowId, horizontal: bool, extent: (usize, usize)) {
        let (w, h) = tree.extent_of(target, extent).unwrap();
        let along = if horizontal { w } else { h };
        let old = along.div_ceil(2);
        tree.split(&Split { target, new, internal, horizontal, before: false, old_size: old, new_size: along - old, limit: false });
    }

    #[test]
    fn splits_of_one_kind_make_one_combination() {
        let mut tree = WindowTree::Leaf(1);
        split(&mut tree, 1, 2, 10, false, (80, 24));
        split(&mut tree, 2, 3, 11, false, (80, 24));
        let WindowTree::Combination(c) = &tree else { panic!() };
        assert_eq!((c.id, c.children.len()), (10, 3));
        assert_eq!(c.children.iter().map(|p| p.size).collect::<Vec<_>>(), [12, 6, 6]);
        // Side by side inside makes an internal window of its own.
        split(&mut tree, 1, 4, 12, true, (80, 24));
        assert_eq!(tree.leaves(), [1, 4, 2, 3]);
        assert_eq!(tree.parent(4).map(|(c, i)| (c.id, i)), Some((12, 1)));
        assert_eq!(tree.parent(12).map(|(c, i)| (c.id, i)), Some((10, 0)));
        let rects = tree.rects(0.0, 0.0, 80.0, 24.0, (1.0, 1.0));
        let r = |id| rects.iter().find(|r| r.id == id).map(|r| (r.x, r.y, r.width, r.height)).unwrap();
        assert_eq!((r(1), r(4), r(2), r(3)), ((0.0, 0.0, 40.0, 12.0), (40.0, 0.0, 40.0, 12.0), (0.0, 12.0, 80.0, 6.0), (0.0, 18.0, 80.0, 6.0)));
    }

    #[test]
    fn deleting_gives_the_space_to_a_sibling_and_drops_a_lone_parent() {
        let mut tree = WindowTree::Leaf(1);
        split(&mut tree, 1, 2, 10, false, (80, 24));
        split(&mut tree, 2, 3, 11, true, (80, 24));
        assert_eq!(tree.remove(3), [11]);
        assert_eq!(tree.leaves(), [1, 2]);
        assert!(tree.combination_of(11).is_none());
        // The first child's space goes to the one after it.
        split(&mut tree, 2, 3, 12, false, (80, 24));
        assert_eq!(tree.remove(1), Vec::<WindowId>::new());
        let WindowTree::Combination(c) = &tree else { panic!() };
        assert_eq!(c.children.iter().map(|p| p.size).collect::<Vec<_>>(), [18, 6]);
    }

    #[test]
    fn a_lone_childs_children_join_a_grandparent_of_their_kind() {
        // [1 | [2 / [3 | 4]]]: deleting 2 leaves [3 | 4] in a combination of its kind.
        let mut tree = WindowTree::Leaf(1);
        split(&mut tree, 1, 2, 10, true, (80, 24));
        split(&mut tree, 2, 3, 11, false, (80, 24));
        split(&mut tree, 3, 4, 12, true, (80, 24));
        assert_eq!(tree.remove(2), [11, 12]);
        let WindowTree::Combination(c) = &tree else { panic!() };
        assert_eq!((c.id, c.children.iter().map(|p| p.tree.id()).collect::<Vec<_>>()), (10, vec![1, 3, 4]));
        assert_eq!(c.children.iter().map(|p| p.size).sum::<usize>(), 80);
    }

    #[test]
    fn resizing_moves_the_edge_to_the_next_sibling_or_the_one_before() {
        let mut tree = WindowTree::Leaf(1);
        split(&mut tree, 1, 2, 10, false, (80, 24));
        split(&mut tree, 2, 3, 11, false, (80, 24));
        assert_eq!(tree.resize(2, 2, false, (80, 24), true, false), Some(2));
        let sizes = |t: &WindowTree| match t {
            WindowTree::Combination(c) => c.children.iter().map(|p| p.size).collect::<Vec<_>>(),
            _ => vec![],
        };
        assert_eq!(sizes(&tree), [12, 8, 4]);
        // The last takes from the one before; no further than window-min-height.
        assert_eq!(tree.resize(3, 10, false, (80, 24), true, false), Some(4));
        assert_eq!(sizes(&tree), [12, 4, 8]);
        // Dragging the last window's mode line moves nothing.
        assert_eq!(tree.resize(3, 1, false, (80, 24), true, true), None);
    }

    #[test]
    fn a_new_frame_size_is_shared_in_proportion() {
        let mut tree = WindowTree::Leaf(1);
        split(&mut tree, 1, 2, 10, false, (80, 24));
        split(&mut tree, 2, 3, 11, false, (80, 24));
        tree.fit((80, 48));
        let sizes = |t: &WindowTree| match t {
            WindowTree::Combination(c) => c.children.iter().map(|p| p.size).collect::<Vec<_>>(),
            _ => vec![],
        };
        assert_eq!(sizes(&tree), [24, 12, 12]);
        // Shrunk and grown back, the sizes are as they were, as Emacs's normal sizes keep them.
        tree.fit((80, 14));
        tree.fit((80, 24));
        assert_eq!(sizes(&tree), [12, 6, 6]);
        tree.fit((80, 3));
        assert!(sizes(&tree).iter().all(|&n| n >= 1), "{:?}", sizes(&tree));
        assert_eq!(tree.enclosing(&[2, 3]), Some(10));
        assert_eq!(tree.enclosing(&[2]), Some(2));
    }
}
