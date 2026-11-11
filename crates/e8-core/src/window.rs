//! Windows, as in Emacs: the frame is divided into windows, each showing a
//! buffer with its own point and scroll position. `C-x 2` and `C-x 3` split
//! the selected window, and the commands that do it are in `window.ts`; the
//! primitives they use are here, as Emacs has them in C.
//!
//! The selected window's point and top line live in its buffer, so commands
//! keep using the buffer's. The other windows' points and starts are kept
//! in their buffers too, moving with edits as Emacs's window-point and
//! window-start markers do.

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::rows::Row;
use crate::variables::Value;

pub type WindowId = u64;

/// The minibuffer's window, as scripts name it, which windows' ids never are.
pub const MINIBUFFER_WINDOW: WindowId = 0;

/// The smallest window that can be made by splitting, counting its mode
/// line, as Emacs's `window-min-height` and `window-min-width`.
const WINDOW_MIN_HEIGHT: usize = 4;
const WINDOW_MIN_WIDTH: usize = 10;

pub(crate) struct Window {
    pub(crate) id: WindowId,
    pub(crate) buffer: u64,
    /// Lines of text and columns, as the front end last laid the window out.
    pub(crate) height: usize,
    pub(crate) width: usize,
    /// When the window was last selected, to choose one after deleting.
    pub(crate) used: u64,
    /// Its parameters, as Emacs's `window-parameter` keeps them, such as
    /// `quit-restore`.
    pub(crate) parameters: std::collections::BTreeMap<String, Value>,
    /// Whether it is dedicated to its buffer: nil, t (strongly), or
    /// anything else (softly), as `set-window-dedicated-p` sets it.
    pub(crate) dedicated: Value,
    /// The buffers it showed before, most recent first, as
    /// `window-prev-buffers` lists them. Where it started in each and its
    /// point there are kept in the buffer, so they move with edits.
    pub(crate) prev_buffers: Vec<u64>,
    /// The buffers `previous-buffer` went back from, as `window-next-buffers`.
    pub(crate) next_buffers: Vec<u64>,
    /// Its margins' widths in columns, as `set-window-margins` set them for
    /// the buffer it then showed; otherwise the buffer's `left-margin-width`
    /// and `right-margin-width` count, as `set-window-buffer` takes them.
    pub(crate) margins: Option<(u64, usize, usize)>,
    /// Whether its cursor is drawn, as `internal-show-cursor` sets it.
    pub(crate) cursor_shown: bool,
}

impl Window {
    pub(crate) fn new(id: WindowId, buffer: u64, width: usize, height: usize) -> Window {
        Window {
            id,
            buffer,
            width,
            height,
            used: 0,
            parameters: Default::default(),
            dedicated: Value::Null,
            prev_buffers: Vec::new(),
            next_buffers: Vec::new(),
            margins: None,
            cursor_shown: true,
        }
    }
}

/// A frame's windows as they were, to put back, as Emacs's
/// `current-window-configuration` keeps them: the tree, each window's
/// buffer, start, point, size and parameters, which window was selected,
/// and which buffer was current. Starts and points are markers, so they
/// follow edits made meanwhile.
pub(crate) struct WindowConfiguration {
    frame: FrameId,
    tree: WindowTree,
    selected: WindowId,
    current: u64,
    /// Whether the minibuffer's window was selected, a prompt being open.
    minibuffer_selected: bool,
    windows: Vec<SavedWindow>,
}

struct SavedWindow {
    id: WindowId,
    buffer: u64,
    /// Markers in the buffer for where the window started and its point.
    start: u64,
    point: u64,
    width: usize,
    height: usize,
    parameters: std::collections::BTreeMap<String, Value>,
    dedicated: Value,
    /// Its previous buffers, with where it started in each and its point,
    /// for an entry the window has dropped meanwhile.
    prev_buffers: Vec<(u64, usize, usize)>,
    next_buffers: Vec<u64>,
}

/// What switching a window to another buffer does with the one it leaves,
/// as `switch-to-prev-buffer`'s BURY-OR-KILL: forget it in the window,
/// because it is being buried or killed, or move it to the end of the
/// window's previous buffers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuryOrKill {
    Bury,
    Kill,
    Append,
}

/// How the frame is divided. A split halves a window, the first part above
/// or to the left keeping the extra line or column of an odd size, until a
/// window is resized and the split takes a size of its own.
#[derive(Clone, Debug, PartialEq)]
pub enum WindowTree {
    Leaf(WindowId),
    Split {
        /// Side by side (`C-x 3`) rather than one above the other (`C-x 2`).
        side_by_side: bool,
        first: Box<WindowTree>,
        second: Box<WindowTree>,
        /// The first part's total size, in lines or columns, once a resize
        /// has set it; half otherwise.
        first_size: Option<usize>,
    },
}

/// How resizing a window went: not in this part of the tree, in it but with
/// no split of the right kind above it yet, or resized by this much.
enum Resize {
    Elsewhere,
    Pending,
    Done(i64),
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

impl WindowTree {
    /// The windows in cyclic order, as `other-window` visits them: left to
    /// right and top to bottom.
    pub fn leaves(&self) -> Vec<WindowId> {
        match self {
            WindowTree::Leaf(id) => vec![*id],
            WindowTree::Split { first, second, .. } => {
                let mut ids = first.leaves();
                ids.extend(second.leaves());
                ids
            }
        }
    }

    /// Divides a rectangle among the windows. Sizes are rounded to whole
    /// units, so cells for a terminal and points for a window both work.
    /// `cell` is a column's width and a line's height, in which a resized
    /// split's size is counted.
    pub fn rects(&self, x: f32, y: f32, width: f32, height: f32, cell: (f32, f32)) -> Vec<WindowRect> {
        let mut out = Vec::new();
        self.rects_into(x, y, width, height, cell, false, &mut out);
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn rects_into(&self, x: f32, y: f32, w: f32, h: f32, cell: (f32, f32), divider: bool, out: &mut Vec<WindowRect>) {
        // The first part's share of `extent`: its own size if a resize set
        // one, kept clear of the edges, or half.
        let share = |size: &Option<usize>, extent: f32, unit: f32| match size {
            Some(n) => (*n as f32 * unit).round().clamp(unit.min(extent), (extent - unit).max(0.0)),
            None => (extent / 2.0).ceil(),
        };
        match self {
            WindowTree::Leaf(id) => out.push(WindowRect { id: *id, x, y, width: w, height: h, divider }),
            WindowTree::Split { side_by_side: true, first, second, first_size } => {
                let left = share(first_size, w, cell.0);
                first.rects_into(x, y, left, h, cell, true, out);
                second.rects_into(x + left, y, w - left, h, cell, divider, out);
            }
            WindowTree::Split { side_by_side: false, first, second, first_size } => {
                let top = share(first_size, h, cell.1);
                first.rects_into(x, y, w, top, cell, divider, out);
                second.rects_into(x, y + top, w, h - top, cell, divider, out);
            }
        }
    }

    /// The smallest a part of the tree can be across or down, as Emacs's
    /// `window-min-width` and `window-min-height` allow for each window.
    fn min_size(&self, horizontal: bool) -> usize {
        match self {
            WindowTree::Leaf(_) => {
                if horizontal {
                    WINDOW_MIN_WIDTH
                } else {
                    WINDOW_MIN_HEIGHT
                }
            }
            WindowTree::Split { side_by_side, first, second, .. } => {
                let (a, b) = (first.min_size(horizontal), second.min_size(horizontal));
                if *side_by_side == horizontal { a + b } else { a.max(b) }
            }
        }
    }

    /// Grows or shrinks a window by up to `delta` lines or columns, taking
    /// them from or giving them to its neighbour in the nearest split of
    /// that kind, as Emacs's `window-resize`. `extent` is this part's size
    /// in cells; with `apply` off, only works out how far it could go.
    /// With `edge`, only a split below or to the right of the window moves,
    /// as dragging its mode line or divider moves that edge.
    #[allow(clippy::too_many_arguments)]
    fn resize(&mut self, id: WindowId, delta: i64, horizontal: bool, extent: (usize, usize), apply: bool, edge: bool) -> Resize {
        let WindowTree::Split { side_by_side, first, second, first_size } = self else {
            return if *self == WindowTree::Leaf(id) { Resize::Pending } else { Resize::Elsewhere };
        };
        let along = if *side_by_side { extent.0 } else { extent.1 };
        let size = first_size.unwrap_or(along.div_ceil(2)).min(along);
        let parts = |n: usize| if *side_by_side { ((n, extent.1), (extent.0 - n, extent.1)) } else { ((extent.0, n), (extent.0, extent.1 - n)) };
        let (first_extent, second_extent) = parts(size);
        let (inner, in_first) = match first.resize(id, delta, horizontal, first_extent, apply, edge) {
            Resize::Elsewhere => (second.resize(id, delta, horizontal, second_extent, apply, edge), false),
            found => (found, true),
        };
        if !matches!(inner, Resize::Pending) || *side_by_side != horizontal || (edge && !in_first) {
            return inner;
        }
        // This split divides the window from its neighbour: move the line.
        let lowest = first.min_size(horizontal) as i64;
        let highest = along as i64 - second.min_size(horizontal) as i64;
        let wanted = size as i64 + if in_first { delta } else { -delta };
        let moved = wanted.clamp(lowest.min(size as i64), highest.max(size as i64));
        if apply {
            *first_size = Some(moved as usize);
        }
        Resize::Done(if in_first { moved - size as i64 } else { size as i64 - moved })
    }

    /// Makes windows side by side as wide as each other, and windows one
    /// above the other as tall, as Emacs's `balance-windows`.
    fn balance(&mut self, extent: (usize, usize)) {
        // How many windows share a run of splits of one kind.
        fn count(tree: &WindowTree, side_by_side: bool) -> usize {
            match tree {
                WindowTree::Split { side_by_side: s, first, second, .. } if *s == side_by_side => {
                    count(first, side_by_side) + count(second, side_by_side)
                }
                _ => 1,
            }
        }
        let WindowTree::Split { side_by_side, first, second, first_size } = self else { return };
        let along = if *side_by_side { extent.0 } else { extent.1 };
        let (a, b) = (count(first, *side_by_side), count(second, *side_by_side));
        let size = (along * a).div_ceil(a + b);
        *first_size = Some(size);
        let (fe, se) = if *side_by_side { ((size, extent.1), (along - size, extent.1)) } else { ((extent.0, size), (extent.0, along - size)) };
        first.balance(fe);
        second.balance(se);
    }

    /// Whether a window shares the frame's width with others, as Emacs's
    /// `window-full-width-p` is false for it.
    pub(crate) fn is_partial_width(&self, id: WindowId) -> bool {
        match self {
            WindowTree::Leaf(_) => false,
            WindowTree::Split { side_by_side, first, second, .. } => {
                let inside = first.leaves().contains(&id) || second.leaves().contains(&id);
                (*side_by_side && inside) || first.is_partial_width(id) || second.is_partial_width(id)
            }
        }
    }

    /// Splits the leaf `id`, the new window after it, or before it, to its
    /// left or above it, with `before`.
    fn split(&mut self, id: WindowId, new: WindowId, side_by_side: bool, before: bool, first_size: Option<usize>) -> bool {
        match self {
            WindowTree::Leaf(leaf) if *leaf == id => {
                let (a, b) = if before { (new, id) } else { (id, new) };
                *self = WindowTree::Split {
                    side_by_side,
                    first: Box::new(WindowTree::Leaf(a)),
                    second: Box::new(WindowTree::Leaf(b)),
                    first_size,
                };
                true
            }
            WindowTree::Leaf(_) => false,
            WindowTree::Split { first, second, .. } => {
                first.split(id, new, side_by_side, before, first_size) || second.split(id, new, side_by_side, before, first_size)
            }
        }
    }

    /// Removes a window, giving its space to its sibling.
    fn remove(&mut self, id: WindowId) -> bool {
        let WindowTree::Split { first, second, .. } = self else { return false };
        if **first == WindowTree::Leaf(id) {
            *self = (**second).clone();
            return true;
        }
        if **second == WindowTree::Leaf(id) {
            *self = (**first).clone();
            return true;
        }
        first.remove(id) || second.remove(id)
    }
}

/// A frame that is not selected: its windows and which of them was
/// selected in it. The selected frame's are the editor's own.
pub(crate) struct Frame {
    pub(crate) id: FrameId,
    tree: WindowTree,
    selected_window: WindowId,
    frame_size: Option<(usize, usize)>,
}

pub type FrameId = u64;

/// The first frame's id. Frames' ids start here, far above any window's,
/// so a number names a window or a frame, never both, as Emacs's window
/// and frame objects are never the same.
pub const FIRST_FRAME: FrameId = 1 << 32;

/// Where a mouse event happened, as the position part of an Emacs mouse
/// event: the window, and the buffer position under the mouse if there is
/// text there. A drag also has where it started.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouseEvent {
    pub window: WindowId,
    pub position: Option<usize>,
    pub start: Option<(WindowId, Option<usize>)>,
}

/// A window as a front end draws it.
pub struct WindowView<'a> {
    pub id: WindowId,
    pub selected: bool,
    pub buffer: &'a Buffer,
    pub point: usize,
    pub top_line: usize,
}

impl Editor {
    pub(crate) fn window(&self, id: WindowId) -> Option<&Window> {
        self.windows.iter().find(|w| w.id == id)
    }

    fn window_mut(&mut self, id: WindowId) -> Option<&mut Window> {
        self.windows.iter_mut().find(|w| w.id == id)
    }

    fn buffer_index(&self, id: u64) -> usize {
        self.buffers.iter().position(|b| b.id == id).unwrap_or(0)
    }

    pub fn window_tree(&self) -> &WindowTree {
        &self.window_tree
    }

    pub fn selected_window(&self) -> WindowId {
        self.selected_window
    }

    /// The windows in cyclic order.
    pub fn window_list(&self) -> Vec<WindowId> {
        self.window_tree.leaves()
    }

    /// The windows with what each shows, in cyclic order.
    pub fn windows(&self) -> Vec<WindowView<'_>> {
        self.window_list()
            .into_iter()
            .filter_map(|id| {
                let w = self.window(id)?;
                let buffer = &self.buffers[self.buffer_index(w.buffer)];
                let selected = id == self.selected_window;
                let (point, top_line) = if selected {
                    (buffer.point(), buffer.top_line)
                } else {
                    (buffer.window_point(id).unwrap_or(buffer.point()), buffer.window_start(id).map_or(0, |p| buffer.line_of(p)))
                };
                Some(WindowView { id, selected, buffer, point, top_line })
            })
            .collect()
    }

    /// The name of the buffer a window shows.
    pub fn window_buffer_name(&self, id: WindowId) -> Option<&str> {
        let w = self.window(id)?;
        Some(&self.buffers[self.buffer_index(w.buffer)].name)
    }

    /// Tells the editor how big a window is: columns, and lines of text
    /// without the mode line and header line. Front ends call this when
    /// they lay windows out.
    pub fn set_window_size(&mut self, id: WindowId, width: usize, height: usize) {
        if let Some(w) = self.window_mut(id) {
            w.width = width.max(1);
            w.height = height.max(1);
        }
    }

    /// The rows a window shows, as [`Editor::window_rows`] gives the selected one's.
    pub fn rows_of_window(&self, id: WindowId, count: usize, dark: bool) -> Vec<Row> {
        let Some(view) = self.windows().into_iter().find(|v| v.id == id) else { return Vec::new() };
        let wrap = self.wrap_in(id, view.buffer);
        let mut rows = self.rows_in(view.buffer, view.top_line, count, dark, wrap);
        self.put_overlay_arrows(view.buffer, &mut rows, dark, self.tab_width_in(view.buffer));
        rows
    }

    /// The frames, newest first, as Emacs's `frame-list` orders them.
    pub fn frame_list(&self) -> Vec<FrameId> {
        self.frame_order.clone()
    }

    pub fn selected_frame(&self) -> FrameId {
        self.selected_frame
    }

    /// Makes a frame showing a buffer, the current one by default, at point
    /// in it, as Emacs's `make-frame` does, and selects it. Returns it.
    pub fn make_frame(&mut self, buffer: Option<&str>) -> Result<FrameId> {
        let index = match buffer {
            Some(name) => self.find_buffer(name).ok_or_else(|| Error::new(format!("No such buffer {name}")))?,
            None => self.current,
        };
        self.next_window_id += 1;
        let window = self.next_window_id;
        let (width, height) = self.window(self.selected_window).map_or((80, 23), |w| (w.width, w.height));
        let point = self.buffers[index].point();
        self.windows.push(Window::new(window, self.buffers[index].id, width, height));
        self.buffers[index].set_window_point(window, point);
        self.next_frame_id += 1;
        let id = self.next_frame_id;
        self.other_frames.push(Frame { id, tree: WindowTree::Leaf(window), selected_window: window, frame_size: self.frame_size });
        self.frame_order.insert(0, id);
        self.select_frame(id)?;
        Ok(id)
    }

    /// Makes a frame the selected one, whose selected window commands act
    /// in, as Emacs's `select-frame`. Each window keeps its own point.
    pub fn select_frame(&mut self, id: FrameId) -> Result<()> {
        if id == self.selected_frame {
            return Ok(());
        }
        let k = self.other_frames.iter().position(|f| f.id == id).ok_or_else(|| Error::new("No such frame"))?;
        // The selected window keeps its point and top line, as when another window is selected.
        let old = self.selected_window;
        let shown = self.selected_buffer_index();
        let b = &mut self.buffers[shown];
        let (point, top) = (b.point(), b.line_start(b.top_line.min(b.line_count() - 1)));
        b.set_window_point(old, point);
        b.set_window_start(old, top);
        let frame = self.other_frames.remove(k);
        self.other_frames.push(Frame {
            id: self.selected_frame,
            tree: std::mem::replace(&mut self.window_tree, frame.tree),
            selected_window: std::mem::replace(&mut self.selected_window, frame.selected_window),
            frame_size: std::mem::replace(&mut self.frame_size, frame.frame_size),
        });
        self.selected_frame = id;
        self.window_use += 1;
        let used = self.window_use;
        let w = self.window_mut(self.selected_window).expect("a frame's selected window exists");
        w.used = used;
        let buffer = w.buffer;
        self.current = self.buffer_index(buffer);
        let b = &mut self.buffers[self.current];
        if let Some(point) = b.remove_window_point(self.selected_window) {
            b.set_point(point);
        }
        let top = b.remove_window_start(self.selected_window).map_or(0, |p| b.line_of(p));
        b.top_line = top.min(b.line_count() - 1);
        Ok(())
    }

    /// Deletes a frame and its windows, as Emacs's `delete-frame`; if it was
    /// selected, the next frame is. The only frame cannot go.
    pub fn delete_frame(&mut self, id: Option<FrameId>) -> Result<()> {
        let id = id.unwrap_or(self.selected_frame);
        if !self.frame_order.contains(&id) {
            return Err(Error::new("No such frame"));
        }
        if self.frame_order.len() == 1 {
            return Err(Error::new("Attempt to delete the sole visible or iconified frame"));
        }
        if id == self.selected_frame {
            let k = self.frame_order.iter().position(|f| *f == id).expect("listed");
            let next = self.frame_order[(k + 1) % self.frame_order.len()];
            self.select_frame(next)?;
        }
        let k = self.other_frames.iter().position(|f| f.id == id).expect("not selected now");
        let frame = self.other_frames.remove(k);
        for window in frame.tree.leaves() {
            self.forget_window(window);
        }
        self.frame_order.retain(|f| *f != id);
        self.frame_parameters.remove(&id);
        self.frame_raises.remove(&id);
        self.tab_bars.remove(&id);
        Ok(())
    }

    /// A frame's windows with what each shows, as [`Editor::windows`] gives
    /// the selected frame's, so a front end can draw any frame.
    pub fn frame_windows(&self, id: FrameId) -> Vec<WindowView<'_>> {
        if id == self.selected_frame {
            return self.windows();
        }
        let Some(frame) = self.other_frames.iter().find(|f| f.id == id) else { return Vec::new() };
        frame
            .tree
            .leaves()
            .into_iter()
            .filter_map(|window| {
                let w = self.window(window)?;
                let buffer = &self.buffers[self.buffer_index(w.buffer)];
                let point = buffer.window_point(window).unwrap_or(buffer.point());
                let top_line = buffer.window_start(window).map_or(0, |p| buffer.line_of(p));
                Some(WindowView { id: window, selected: false, buffer, point, top_line })
            })
            .collect()
    }

    /// A frame's window tree, for laying it out.
    pub fn frame_tree(&self, id: FrameId) -> Option<&WindowTree> {
        if id == self.selected_frame {
            return Some(&self.window_tree);
        }
        self.other_frames.iter().find(|f| f.id == id).map(|f| &f.tree)
    }

    /// The rows a window of any frame shows.
    pub fn rows_of_frame_window(&self, frame: FrameId, id: WindowId, count: usize, dark: bool) -> Vec<Row> {
        let Some(view) = self.frame_windows(frame).into_iter().find(|v| v.id == id) else { return Vec::new() };
        let wrap = self.wrap_in(id, view.buffer);
        self.rows_in(view.buffer, view.top_line, count, dark, wrap)
    }

    /// Tells the editor how big the frame is, in columns and in lines with
    /// the mode lines but not the echo area, as Emacs's root window counts
    /// them. The windows are laid out in it; a front end may then refine
    /// each with [`Editor::set_window_size`].
    pub fn set_frame_size(&mut self, cols: usize, lines: usize) {
        self.frame_size = Some((cols.max(1), lines.max(1)));
        self.relayout();
    }

    /// Each window's total size, in columns with its divider and lines with
    /// its mode line, as Emacs's `window-total-width` and `-height`.
    pub fn window_total_sizes(&self) -> Vec<(WindowId, usize, usize)> {
        let (cols, lines) = self.frame_cells();
        self.window_tree
            .rects(0.0, 0.0, cols as f32, lines as f32, (1.0, 1.0))
            .iter()
            .map(|r| (r.id, r.width as usize, r.height as usize))
            .collect()
    }

    /// A window's edges in its frame, in columns and lines from the frame's
    /// top left, as Emacs's `window-edges`: left, top, right and bottom,
    /// its mode line and divider included, or with `body` only its text
    /// area. The minibuffer's window is below the frame's windows.
    pub fn window_edges(&self, id: WindowId, body: bool) -> Option<(usize, usize, usize, usize)> {
        let frame = self.window_frame(id)?;
        let (cols, lines) = if frame == self.selected_frame {
            self.frame_cells()
        } else {
            self.other_frames.iter().find(|f| f.id == frame).and_then(|f| f.frame_size).unwrap_or_else(|| self.frame_cells())
        };
        if id == MINIBUFFER_WINDOW {
            return Some((0, lines, cols, lines + self.mini_window_lines()));
        }
        let rect = self.frame_tree(frame)?.rects(0.0, 0.0, cols as f32, lines as f32, (1.0, 1.0)).into_iter().find(|r| r.id == id)?;
        let (left, top) = (rect.x as usize, rect.y as usize);
        let (right, bottom) = (left + rect.width as usize, top + rect.height as usize);
        if !body {
            return Some((left, top, right, bottom));
        }
        let header = usize::from(self.window_wants_header_line(id, rect.height as usize));
        let mode = usize::from(self.window_shows_mode_line(id));
        let divider = usize::from(rect.divider);
        Some((left, top + header, right.saturating_sub(divider).max(left), bottom.saturating_sub(mode).max(top + header)))
    }

    /// The frame in cells, without the echo area: as a front end said, or
    /// as the windows add up to.
    pub fn frame_cells(&self) -> (usize, usize) {
        self.frame_size.unwrap_or_else(|| {
            let w = self.window(self.selected_window);
            (w.map_or(80, |w| w.width), w.map_or(24, |w| w.height + 1))
        })
    }

    /// Lays the windows out in the frame, as their sizes in the tree say.
    fn relayout(&mut self) {
        let Some((cols, lines)) = self.frame_size else { return };
        for r in self.window_tree.rects(0.0, 0.0, cols as f32, lines as f32, (1.0, 1.0)) {
            let divider = usize::from(r.divider);
            let header = usize::from(self.window_wants_header_line(r.id, r.height as usize));
            if let Some(w) = self.window_mut(r.id) {
                w.width = (r.width as usize).saturating_sub(divider).max(1);
                w.height = (r.height as usize).saturating_sub(1 + header).max(1);
            }
        }
    }

    /// Grows a window by `delta` lines, or columns if `horizontal`, taking
    /// them from its neighbour; a negative delta shrinks it. As far as the
    /// windows' smallest sizes allow, as Emacs's `window-resize` with
    /// `window--resizable` does: returns how far it went, or with `apply`
    /// off, how far it could.
    pub fn resize_window(&mut self, id: Option<WindowId>, delta: i64, horizontal: bool, apply: bool) -> Result<i64> {
        let id = id.unwrap_or(self.selected_window);
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        let extent = self.frame_cells();
        let moved = match self.window_tree.resize(id, delta, horizontal, extent, apply, false) {
            Resize::Done(n) => n,
            _ => 0,
        };
        if apply {
            self.relayout();
        }
        Ok(moved)
    }

    /// Moves a window's bottom edge, or its right edge if `horizontal`, by
    /// `delta` lines or columns, as dragging its mode line or divider does
    /// in Emacs. A window with nothing below or to its right stays as it is.
    pub fn move_window_edge(&mut self, id: WindowId, delta: i64, horizontal: bool) -> i64 {
        let extent = self.frame_cells();
        let moved = match self.window_tree.resize(id, delta, horizontal, extent, true, true) {
            Resize::Done(n) => n,
            _ => 0,
        };
        self.relayout();
        moved
    }

    /// Makes the windows the same size as their neighbours, as Emacs's
    /// `balance-windows`.
    pub fn balance_windows(&mut self) {
        let extent = self.frame_cells();
        self.window_tree.balance(extent);
        self.relayout();
    }

    /// Shows a buffer in a window, as Emacs's `set-window-buffer`: in the
    /// selected window it becomes the current buffer; another window shows
    /// it from its top, with its own point where the buffer's is. A window
    /// strongly dedicated to another buffer refuses; one softly dedicated
    /// stops being so.
    pub fn set_window_buffer(&mut self, id: WindowId, name: &str) -> Result<()> {
        let index = self.find_buffer(name).ok_or_else(|| Error::new(format!("No such buffer {name}")))?;
        let w = self.window(id).ok_or_else(|| Error::new("No such window"))?;
        if w.buffer != self.buffers[index].id {
            if w.dedicated == Value::Bool(true) {
                let shown = self.window_buffer_name(id).unwrap_or_default();
                return Err(Error::new(format!("Window is dedicated to ‘{shown}’")));
            }
            self.window_mut(id).expect("checked").dedicated = Value::Null;
        }
        if id == self.selected_window {
            self.select(index);
            return Ok(());
        }
        let w = self.window(id).expect("checked");
        let old = self.buffer_index(w.buffer);
        if self.buffers[old].id != self.buffers[index].id {
            self.record_window_buffer(id);
        }
        self.unshow_buffer(id);
        self.buffers[old].remove_window_point(id);
        self.buffers[old].remove_window_start(id);
        let buffer = self.buffers[index].id;
        let height = self.window(id).map_or(1, |w| w.height.max(1));
        let w = self.window_mut(id).expect("checked");
        w.buffer = buffer;
        // From where the buffer was last shown, at its point, as Emacs's
        // set_window_buffer; recentred if that leaves point out of sight,
        // as redisplay would.
        let b = &mut self.buffers[index];
        let point = b.point();
        let mut top = b.line_of(b.last_window_start.min(b.len()));
        let line = b.line_of(point);
        if line < top || line >= top + height {
            top = line.saturating_sub(height / 2);
        }
        let start = b.line_start(top);
        b.set_window_point(id, point);
        b.set_window_start(id, start);
        Ok(())
    }

    /// Notes where a window started in its buffer as it stops showing it,
    /// for the next window to show it, as Emacs's unshow_buffer.
    pub(crate) fn unshow_buffer(&mut self, id: WindowId) {
        let Some(start) = self.window_start(id) else { return };
        let buffer = self.window(id).expect("has a start").buffer;
        let index = self.buffer_index(buffer);
        let point = self.window_point(id);
        let b = &mut self.buffers[index];
        b.last_window_start = start;
        // Unless the selected window shows the buffer, whose point is the
        // buffer's, the buffer's point becomes where the window had it.
        let selected_shows = self.windows.iter().any(|w| w.id == self.selected_window && w.buffer == buffer);
        if let (false, Some(point)) = (selected_shows, point) {
            b.set_point(point);
        }
    }

    /// When a window was last selected, as a count: higher is more recent.
    pub fn window_use_time(&self, id: WindowId) -> Option<u64> {
        self.window(id).map(|w| w.used)
    }

    /// Whether a window spans the frame's width, as `window-full-width-p`.
    pub fn window_full_width(&self, id: WindowId) -> bool {
        !self.window_tree.is_partial_width(id)
    }

    /// A window's size: columns, and lines of text without the mode line.
    pub fn window_size(&self, id: WindowId) -> Option<(usize, usize)> {
        self.window(id).map(|w| (w.width, w.height))
    }

    /// Splits a window in two, as Emacs's `split-window`: below it, or to its
    /// right. The new window shows the same buffer at the same place. Returns it.
    pub fn split_window(&mut self, id: Option<WindowId>, side_by_side: bool) -> Result<WindowId> {
        self.split_window_sized(id, side_by_side, None)
    }

    /// Splits a window as [`Editor::split_window`] does, with `size` lines or
    /// columns for the window split, or for the new one if it is negative,
    /// as Emacs's `split-window` takes them; half each without.
    pub fn split_window_sized(&mut self, id: Option<WindowId>, side_by_side: bool, size: Option<i64>) -> Result<WindowId> {
        self.split_window_toward(id, side_by_side, false, size)
    }

    /// Splits a window as [`Editor::split_window_sized`] does, the new
    /// window to its left or above it with `before`, as `split-window`'s
    /// SIDE `left` and `above`.
    pub fn split_window_toward(&mut self, id: Option<WindowId>, side_by_side: bool, before: bool, size: Option<i64>) -> Result<WindowId> {
        let id = id.unwrap_or(self.selected_window);
        let view = self
            .windows()
            .into_iter()
            .find(|v| v.id == id)
            .map(|v| (v.point, v.top_line, v.buffer.id))
            .ok_or_else(|| Error::new("No such window"))?;
        let w = self.window(id).expect("listed windows exist");
        let (width, height) = (w.width, w.height);
        let buffer_name = self.window_buffer_name(id).unwrap_or_default().to_string();
        // Total sizes, divider and mode line included, as window-min-width
        // and window-min-height count them.
        let total = self.window_total_sizes().into_iter().find(|s| s.0 == id);
        let (total_width, total_height) = total.map_or((width, height + 1), |s| (s.1, s.2));
        let too_small = if side_by_side {
            total_width < 2 * WINDOW_MIN_WIDTH
        } else {
            total_height < 2 * WINDOW_MIN_HEIGHT
        };
        // An explicit size only has to leave each window its safe minimum,
        // as window-safe-min-height and -width give: a line and the mode
        // line, or two columns.
        let first_size = match size {
            None => None,
            Some(size) => {
                let total = self
                    .window_total_sizes()
                    .into_iter()
                    .find(|s| s.0 == id)
                    .map_or(0, |s| if side_by_side { s.1 } else { s.2 }) as i64;
                let safe = 2;
                let (old, new) = if size >= 0 { (size, total - size) } else { (total + size, -size) };
                if new < safe {
                    return Err(Error::new("Size of new window too small"));
                }
                if old < safe {
                    return Err(Error::new("Size of window too small"));
                }
                // The first part is the new window's when it goes before.
                Some(if before { new } else { old } as usize)
            }
        };
        if too_small && first_size.is_none() {
            return Err(Error::new(format!("Window #<window {id} on {buffer_name}> too small for splitting")));
        }
        self.next_window_id += 1;
        let new = self.next_window_id;
        let (old_size, new_size) = if side_by_side {
            let left = width.div_ceil(2);
            ((left - 1, height), (width - left, height))
        } else {
            let top = (height + 1).div_ceil(2);
            ((width, top - 1), (width, height + 1 - top - 1))
        };
        let (old_size, new_size) = if before { (new_size, old_size) } else { (old_size, new_size) };
        let w = self.window_mut(id).expect("listed windows exist");
        (w.width, w.height) = old_size;
        // A new window has showed no buffers before, as in Emacs.
        self.windows.push(Window::new(new, view.2, new_size.0, new_size.1));
        let index = self.buffer_index(view.2);
        let b = &mut self.buffers[index];
        b.set_window_point(new, view.0);
        let start = b.line_start(view.1.min(b.line_count() - 1));
        b.set_window_start(new, start);
        self.window_tree.split(id, new, side_by_side, before, first_size);
        self.relayout();
        Ok(new)
    }

    /// Splits the frame's root window, as Emacs's `split-root-window-below`
    /// and `-right`: the new window, showing the selected window's buffer,
    /// takes the whole bottom or right of the frame. `size` is as
    /// split-window's: the old part's lines or columns, or the new window's
    /// if negative.
    pub fn split_root_window(&mut self, side_by_side: bool, size: Option<i64>) -> Result<WindowId> {
        self.split_root_window_toward(side_by_side, false, size)
    }

    /// Splits the frame's root window as [`Editor::split_root_window`] does,
    /// the new window along its left or top with `before`.
    pub fn split_root_window_toward(&mut self, side_by_side: bool, before: bool, size: Option<i64>) -> Result<WindowId> {
        let (cols, lines) = self.frame_cells();
        let total = if side_by_side { cols } else { lines } as i64;
        let first_size = match size {
            None if total < 2 * if side_by_side { WINDOW_MIN_WIDTH } else { WINDOW_MIN_HEIGHT } as i64 => {
                return Err(Error::new("Root window too small for splitting"));
            }
            None => None,
            Some(size) => {
                let (old, new) = if size >= 0 { (size, total - size) } else { (total + size, -size) };
                if new < 2 {
                    return Err(Error::new("Size of new window too small"));
                }
                if old < 2 {
                    return Err(Error::new("Size of window too small"));
                }
                Some(if before { new } else { old } as usize)
            }
        };
        let selected = self.selected_window;
        let view = self.windows().into_iter().find(|v| v.id == selected).map(|v| (v.point, v.top_line, v.buffer.id)).ok_or_else(|| Error::new("No such window"))?;
        self.next_window_id += 1;
        let new = self.next_window_id;
        self.windows.push(Window::new(new, view.2, cols, 1));
        let index = self.buffer_index(view.2);
        let b = &mut self.buffers[index];
        b.set_window_point(new, view.0);
        let start = b.line_start(view.1.min(b.line_count() - 1));
        b.set_window_start(new, start);
        let tree = std::mem::replace(&mut self.window_tree, WindowTree::Leaf(new));
        let (first, second) = if before { (WindowTree::Leaf(new), tree) } else { (tree, WindowTree::Leaf(new)) };
        self.window_tree = WindowTree::Split { side_by_side, first: Box::new(first), second: Box::new(second), first_size };
        self.relayout();
        Ok(new)
    }

    /// Deletes a window, giving its space to its neighbour, as Emacs's
    /// `delete-window`. If it was selected, the most recently used window
    /// left is selected.
    pub fn delete_window(&mut self, id: Option<WindowId>) -> Result<()> {
        let id = id.unwrap_or(self.selected_window);
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        // Only the selected frame's windows count.
        let leaves = self.window_tree.leaves();
        if !leaves.contains(&id) {
            return Err(Error::new("No such window"));
        }
        if leaves.len() == 1 {
            return Err(Error::new("Attempt to delete minibuffer or sole ordinary window"));
        }
        if id == self.selected_window {
            let next = self
                .windows
                .iter()
                .filter(|w| w.id != id && leaves.contains(&w.id))
                .max_by_key(|w| w.used)
                .map(|w| w.id)
                .expect("another window");
            self.select_window_norecord(next)?;
        }
        self.forget_window(id);
        self.window_tree.remove(id);
        self.relayout();
        Ok(())
    }

    /// Makes a window the selected one, whose buffer commands act on, and
    /// puts its buffer first in the buffer list, as Emacs's `select-window`.
    pub fn select_window(&mut self, id: WindowId) -> Result<()> {
        self.select_window_norecord(id)?;
        if id != MINIBUFFER_WINDOW {
            let buffer = self.window(id).expect("selected").buffer;
            self.record_buffer(buffer);
        }
        Ok(())
    }

    /// Selects a window, leaving the buffer list as it is, as
    /// `select-window` does with NORECORD.
    pub fn select_window_norecord(&mut self, id: WindowId) -> Result<()> {
        if id == MINIBUFFER_WINDOW {
            return self.select_minibuffer_window();
        }
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        // Leaving the minibuffer's window, as C-x o from it does; the prompt stays open.
        if self.minibuffer_window_selected {
            self.minibuffer_window_selected = false;
            self.current = self.selected_buffer_index();
        }
        self.window_use += 1;
        let used = self.window_use;
        if id == self.selected_window {
            self.window_mut(id).expect("checked").used = used;
            return Ok(());
        }
        // The old window keeps its own point and top line, in the buffer it
        // shows, which need not be the current one.
        let old = self.selected_window;
        let shown = self.selected_buffer_index();
        let b = &mut self.buffers[shown];
        let (point, top) = (b.point(), b.line_start(b.top_line.min(b.line_count() - 1)));
        b.set_window_point(old, point);
        b.set_window_start(old, top);
        let w = self.window_mut(id).expect("checked");
        w.used = used;
        let buffer = w.buffer;
        self.selected_window = id;
        self.current = self.buffer_index(buffer);
        let b = &mut self.buffers[self.current];
        if let Some(point) = b.remove_window_point(id) {
            b.set_point(point);
        }
        let top = b.remove_window_start(id).map_or(0, |p| b.line_of(p));
        b.top_line = top.min(b.line_count() - 1);
        Ok(())
    }

    /// Keeps the selected window's record of its buffer up to date when the
    /// buffer it shows changes.
    pub(crate) fn selected_window_shows(&mut self, index: usize) {
        let id = self.buffers[index].id;
        let selected = self.selected_window;
        if let Some(w) = self.window_mut(selected) {
            w.buffer = id;
        }
    }

    /// Shows other buffers in the windows showing a buffer that is going,
    /// as Emacs's replace-buffer-in-windows does: a window dedicated to it
    /// is deleted if it can be, with its frame if it is the frame's only
    /// window; any other goes back to the buffer it showed before, as
    /// `switch-to-prev-buffer` finds it, or is deleted if there is none.
    /// Windows that only showed it before forget it.
    pub(crate) fn replace_buffer_in_windows(&mut self, gone: u64) {
        let mut windows = self.window_tree.leaves();
        if let Some(k) = windows.iter().position(|&w| w == self.selected_window) {
            windows.rotate_left(k);
        }
        windows.extend(self.other_frames.iter().flat_map(|f| f.tree.leaves()));
        for id in windows {
            let Some(w) = self.window(id) else { continue };
            if w.buffer != gone {
                self.unrecord_window_buffer(id, gone);
                continue;
            }
            if w.dedicated.is_true() && self.delete_window_for(id, true) {
                continue;
            }
            self.window_mut(id).expect("checked").dedicated = Value::Null;
            if !matches!(self.switch_to_prev_buffer(id, Some(BuryOrKill::Kill)), Ok(Some(_))) {
                self.delete_window_for(id, true);
            }
        }
    }

    /// Deletes a window that showed a buffer being killed or quit, as
    /// Emacs's window--delete: the window, if its frame has others, else
    /// its frame if there are other frames and `kill`. Says whether it went.
    fn delete_window_for(&mut self, id: WindowId, kill: bool) -> bool {
        let frame = if self.window_tree.leaves().contains(&id) {
            None
        } else {
            match self.other_frames.iter().find(|f| f.tree.leaves().contains(&id)) {
                Some(f) => Some(f.id),
                None => return false,
            }
        };
        let tree = frame.map_or(&self.window_tree, |f| &self.other_frames.iter().find(|x| x.id == f).expect("found").tree);
        if tree.leaves().len() > 1 {
            match frame {
                None => self.delete_window(Some(id)).is_ok(),
                Some(f) => {
                    let leaves = tree.leaves();
                    let next = self.windows.iter().filter(|w| w.id != id && leaves.contains(&w.id)).max_by_key(|w| w.used).map(|w| w.id);
                    let frame = self.other_frames.iter_mut().find(|x| x.id == f).expect("found");
                    frame.tree.remove(id);
                    if frame.selected_window == id {
                        frame.selected_window = next.expect("another window");
                    }
                    self.forget_window(id);
                    true
                }
            }
        } else {
            kill && self.frame_order.len() > 1 && self.delete_frame(Some(frame.unwrap_or(self.selected_frame))).is_ok()
        }
    }

    /// Drops a window, whose buffers forget what they kept for it.
    fn forget_window(&mut self, id: WindowId) {
        self.unshow_buffer(id);
        for b in &mut self.buffers {
            b.forget_window(id);
        }
        self.windows.retain(|w| w.id != id);
    }

    /// Notes the buffer a window shows before it shows another, at the head
    /// of its previous buffers, with where it started and its point, as
    /// Emacs's record-window-buffer does; buffers whose names start with a
    /// space are not noted. The buffers previous-buffer left are forgotten.
    pub(crate) fn record_window_buffer(&mut self, id: WindowId) {
        let Some(w) = self.window_mut(id) else { return };
        w.next_buffers.clear();
        let buffer = w.buffer;
        let Some(index) = self.buffer_with_id(buffer) else { return };
        if self.buffers[index].name.starts_with(' ') {
            return;
        }
        let (start, point) = (self.window_start(id).unwrap_or(0), self.window_point(id).unwrap_or(0));
        self.buffers[index].set_prev_entry(id, start, point);
        let w = self.window_mut(id).expect("checked");
        w.prev_buffers.retain(|b| *b != buffer);
        w.prev_buffers.insert(0, buffer);
    }

    /// Forgets a buffer in a window's previous and next buffers, as
    /// Emacs's unrecord-window-buffer.
    fn unrecord_window_buffer(&mut self, id: WindowId, buffer: u64) {
        if let Some(w) = self.window_mut(id) {
            w.prev_buffers.retain(|b| *b != buffer);
            w.next_buffers.retain(|b| *b != buffer);
        }
        if let Some(index) = self.buffer_with_id(buffer) {
            self.buffers[index].remove_prev_entry(id);
        }
    }

    /// Shows a buffer in a window, from `start` and with `point` where they
    /// are given, as Emacs's set-window-buffer-start-and-point. The current
    /// buffer changes only if the window is selected and showed it.
    pub fn set_window_buffer_start_and_point(&mut self, id: WindowId, name: &str, start: Option<usize>, point: Option<usize>) -> Result<()> {
        let current = self.buffers[self.current].id;
        let showed_current = self.window(id).is_some_and(|w| w.buffer == current);
        self.set_window_buffer(id, name)?;
        if !(id == self.selected_window && showed_current) {
            self.current = self.buffer_with_id(current).unwrap_or(self.current);
        }
        if let Some(start) = start {
            self.set_window_start(id, start)?;
        }
        if let Some(point) = point {
            self.set_window_point(id, point)?;
        }
        Ok(())
    }

    /// The buffers, most recently selected first, as the selected frame's
    /// `buffer-list` orders them, by id.
    fn frame_buffer_list(&self) -> Vec<u64> {
        self.buffer_list().into_iter().map(|i| self.buffers[i].id).collect()
    }

    fn window_error(&self, id: WindowId) -> Error {
        let name = self.window_buffer_name(id).unwrap_or_default();
        Error::new(format!("Window #<window {id} on {name}> is dedicated to buffer #<buffer {name}>"))
    }

    /// Shows in a window the buffer it showed before, as Emacs's
    /// `switch-to-prev-buffer`: the first of its previous buffers that
    /// `previous-buffer` has not just left, with where it started there and
    /// its point; else the buffer list's, least recently selected first;
    /// else those it left. Returns the buffer's name, or none if there is
    /// no other buffer. With `bury_or_kill`, the buffer the window leaves
    /// is not one to come back to, and the buffer list is gone through most
    /// recent first.
    pub fn switch_to_prev_buffer(&mut self, id: WindowId, bury_or_kill: Option<BuryOrKill>) -> Result<Option<String>> {
        let w = self.window(id).ok_or_else(|| Error::new("No such window"))?;
        if w.dedicated.is_true() {
            return Err(self.window_error(id));
        }
        let (old, prev, next) = (w.buffer, w.prev_buffers.clone(), w.next_buffers.clone());
        let live = |ed: &Editor, b: u64| ed.buffer_with_id(b).is_some();
        let mut found = prev.iter().copied().find(|&b| b != old && live(self, b) && (bury_or_kill.is_some() || !next.contains(&b))).map(|b| (b, true));
        if found.is_none() {
            let mut list = self.frame_buffer_list();
            if bury_or_kill.is_none() {
                list.reverse();
            }
            found = list
                .into_iter()
                .find(|&b| b != old && !self.buffers[self.buffer_index(b)].name.starts_with(' ') && (bury_or_kill.is_some() || !next.contains(&b)))
                .map(|b| (b, false));
        }
        if found.is_none() && bury_or_kill.is_none() {
            found = next.iter().rev().copied().find(|&b| b != old && live(self, b) && prev.contains(&b)).map(|b| (b, true));
        }
        if let Some((b, with_entry)) = found {
            let index = self.buffer_index(b);
            let entry = if with_entry { self.buffers[index].prev_entry(id) } else { None };
            let name = self.buffers[index].name.clone();
            self.set_window_buffer_start_and_point(id, &name, entry.map(|e| e.0), entry.map(|e| e.1))?;
        }
        let old_index = self.buffer_with_id(old);
        let w = self.window_mut(id).expect("checked");
        match bury_or_kill {
            Some(how) => {
                let had = w.prev_buffers.contains(&old);
                w.prev_buffers.retain(|b| *b != old);
                w.next_buffers = next.into_iter().filter(|b| *b != old).collect();
                if how == BuryOrKill::Append && had {
                    w.prev_buffers.push(old);
                } else if let Some(i) = old_index {
                    self.buffers[i].remove_prev_entry(id);
                }
            }
            None => w.next_buffers = std::iter::once(old).chain(next.into_iter().filter(|b| *b != old)).collect(),
        }
        self.forget_killed_buffers(id);
        Ok(found.map(|(b, _)| self.buffers[self.buffer_index(b)].name.clone()))
    }

    /// Shows in a window the buffer `previous-buffer` left, as Emacs's
    /// `switch-to-next-buffer`: the first of its next buffers, with where it
    /// started there and its point; else the buffer list's first that it has
    /// not shown; else its previous buffers, least recent first. Returns the
    /// buffer's name, or none if there is no other buffer.
    pub fn switch_to_next_buffer(&mut self, id: WindowId) -> Result<Option<String>> {
        let w = self.window(id).ok_or_else(|| Error::new("No such window"))?;
        if w.dedicated.is_true() {
            return Err(self.window_error(id));
        }
        let (old, prev, next) = (w.buffer, w.prev_buffers.clone(), w.next_buffers.clone());
        let live = |ed: &Editor, b: u64| ed.buffer_with_id(b).is_some();
        let mut found = next.iter().copied().find(|&b| b != old && live(self, b) && prev.contains(&b)).map(|b| (b, true));
        if found.is_none() {
            found = self
                .frame_buffer_list()
                .into_iter()
                .find(|&b| b != old && !self.buffers[self.buffer_index(b)].name.starts_with(' ') && !prev.contains(&b))
                .map(|b| (b, false));
        }
        if found.is_none() {
            found = prev.iter().rev().copied().find(|&b| b != old && live(self, b)).map(|b| (b, true));
        }
        if let Some((b, with_entry)) = found {
            let index = self.buffer_index(b);
            let entry = if with_entry { self.buffers[index].prev_entry(id) } else { None };
            let name = self.buffers[index].name.clone();
            self.set_window_buffer_start_and_point(id, &name, entry.map(|e| e.0), entry.map(|e| e.1))?;
        }
        let new = found.map(|(b, _)| b);
        self.window_mut(id).expect("checked").next_buffers = next.into_iter().filter(|b| Some(*b) != new).collect();
        self.forget_killed_buffers(id);
        Ok(new.map(|b| self.buffers[self.buffer_index(b)].name.clone()))
    }

    /// Drops killed buffers from a window's previous and next buffers.
    fn forget_killed_buffers(&mut self, id: WindowId) {
        let live: Vec<u64> = self.buffers.iter().map(|b| b.id).collect();
        if let Some(w) = self.window_mut(id) {
            w.prev_buffers.retain(|b| live.contains(b));
            w.next_buffers.retain(|b| live.contains(b));
        }
    }

    /// A window's left and right margins in columns, as Emacs's
    /// `window-margins`: as `set-window-margins` set them while it shows the
    /// same buffer, else its buffer's `left-margin-width` and
    /// `right-margin-width`. Front ends leave them beside the text.
    pub fn window_margins(&self, id: WindowId) -> (usize, usize) {
        let Some(w) = self.window(id) else { return (0, 0) };
        if let Some((buffer, left, right)) = w.margins
            && buffer == w.buffer
        {
            return (left, right);
        }
        let Some(index) = self.buffer_with_id(w.buffer) else { return (0, 0) };
        let b = &self.buffers[index];
        let width = |name: &str| self.variable_in(b, name).and_then(|v| v.as_number()).map_or(0, |n| n.max(0.0) as usize);
        (width("left-margin-width"), width("right-margin-width"))
    }

    /// Sets a window's margins while it shows its buffer, as Emacs's
    /// `set-window-margins`. Returns whether they changed.
    pub fn set_window_margins(&mut self, id: WindowId, left: usize, right: usize) -> bool {
        let before = self.window_margins(id);
        if let Some(w) = self.window_mut(id) {
            w.margins = Some((w.buffer, left, right));
        }
        before != (left, right)
    }

    /// Whether a window's cursor is drawn, as Emacs's `internal-show-cursor-p`,
    /// and not hidden by its buffer's `cursor-type` being nil, as transient's
    /// and vundo's buffers have it.
    pub fn window_cursor_shown(&self, id: WindowId) -> bool {
        let Some(w) = self.window(id) else { return true };
        let hidden = self.buffers.iter().find(|b| b.id() == w.buffer).is_some_and(|b| matches!(self.variable_in(b, "cursor-type"), Some(Value::Null | Value::Bool(false))));
        w.cursor_shown && !hidden
    }

    /// Shows or hides a window's cursor, as `internal-show-cursor`.
    pub fn show_window_cursor(&mut self, id: WindowId, shown: bool) {
        if let Some(w) = self.window_mut(id) {
            w.cursor_shown = shown;
        }
    }

    /// A window's parameter, as Emacs's `window-parameter`.
    pub fn window_parameter(&self, id: WindowId, name: &str) -> Option<&Value> {
        self.window(id)?.parameters.get(name)
    }

    /// Sets a window's parameter, or with null takes it away, as `set-window-parameter`.
    pub fn set_window_parameter(&mut self, id: WindowId, name: &str, value: Value) -> Result<()> {
        let w = self.window_mut(id).ok_or_else(|| Error::new("No such window"))?;
        if value == Value::Null {
            w.parameters.remove(name);
        } else {
            w.parameters.insert(name.to_string(), value);
        }
        Ok(())
    }

    /// A window's parameters, as `window-parameters`.
    pub fn window_parameters(&self, id: WindowId) -> Vec<(String, Value)> {
        self.window(id).map(|w| w.parameters.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
    }

    /// Whether a window is dedicated to its buffer, as `window-dedicated-p`:
    /// nil, t for strongly, or what it was set to.
    pub fn window_dedicated(&self, id: WindowId) -> Value {
        self.window(id).map_or(Value::Null, |w| w.dedicated.clone())
    }

    pub fn set_window_dedicated(&mut self, id: WindowId, flag: Value) -> Result<()> {
        let w = self.window_mut(id).ok_or_else(|| Error::new("No such window"))?;
        w.dedicated = if flag.is_true() { flag } else { Value::Null };
        Ok(())
    }

    /// The buffers a window showed before, most recent first, each with
    /// where it started and its point, as `window-prev-buffers`.
    pub fn window_prev_buffers(&self, id: WindowId) -> Vec<(String, usize, usize)> {
        let Some(w) = self.window(id) else { return Vec::new() };
        w.prev_buffers
            .iter()
            .filter_map(|&b| {
                let b = &self.buffers[self.buffer_with_id(b)?];
                let (start, point) = b.prev_entry(id).unwrap_or((0, 0));
                Some((b.name.clone(), start, point))
            })
            .collect()
    }

    pub fn set_window_prev_buffers(&mut self, id: WindowId, buffers: Vec<(String, usize, usize)>) -> Result<()> {
        let old = self.window(id).ok_or_else(|| Error::new("No such window"))?.prev_buffers.clone();
        for b in old {
            if let Some(i) = self.buffer_with_id(b) {
                self.buffers[i].remove_prev_entry(id);
            }
        }
        let mut entries = Vec::new();
        for (name, start, point) in buffers {
            let Some(i) = self.find_buffer(&name) else { continue };
            let b = &mut self.buffers[i];
            if !entries.contains(&b.id) {
                b.set_prev_entry(id, start.min(b.len()), point.min(b.len()));
                entries.push(b.id);
            }
        }
        self.window_mut(id).expect("checked").prev_buffers = entries;
        Ok(())
    }

    /// The buffers `previous-buffer` left in a window, as `window-next-buffers`.
    pub fn window_next_buffers(&self, id: WindowId) -> Vec<String> {
        let Some(w) = self.window(id) else { return Vec::new() };
        w.next_buffers.iter().filter_map(|&b| self.buffer_with_id(b).map(|i| self.buffers[i].name.clone())).collect()
    }

    pub fn set_window_next_buffers(&mut self, id: WindowId, buffers: Vec<String>) -> Result<()> {
        let entries = buffers.into_iter().filter_map(|name| self.find_buffer(&name).map(|i| self.buffers[i].id)).collect();
        self.window_mut(id).ok_or_else(|| Error::new("No such window"))?.next_buffers = entries;
        Ok(())
    }

    /// Where a window starts, as `window-start`.
    pub fn window_start(&self, id: WindowId) -> Option<usize> {
        let w = self.window(id)?;
        let b = &self.buffers[self.buffer_index(w.buffer)];
        Some(if id == self.selected_window { b.line_start(b.top_line.min(b.line_count() - 1)) } else { b.window_start(id).unwrap_or(0) })
    }

    /// A window's point, as `window-point`: the buffer's in the selected
    /// window, the window's own in another.
    pub fn window_point(&self, id: WindowId) -> Option<usize> {
        let w = self.window(id)?;
        let b = &self.buffers[self.buffer_index(w.buffer)];
        Some(if id == self.selected_window { b.point() } else { b.window_point(id).unwrap_or(b.point()) })
    }

    /// Moves a window's point, as `set-window-point`; in the selected
    /// window, that is its buffer's point.
    pub fn set_window_point(&mut self, id: WindowId, pos: usize) -> Result<()> {
        let w = self.window(id).ok_or_else(|| Error::new("No such window"))?;
        let index = self.buffer_index(w.buffer);
        let b = &mut self.buffers[index];
        let pos = pos.min(b.len());
        if id == self.selected_window {
            b.set_point(pos);
        } else {
            b.set_window_point(id, pos);
        }
        Ok(())
    }

    /// Makes a window start at the line holding `pos`, as `set-window-start`
    /// does, though a window here always starts at a line's start.
    pub fn set_window_start(&mut self, id: WindowId, pos: usize) -> Result<()> {
        let w = self.window(id).ok_or_else(|| Error::new("No such window"))?;
        let index = self.buffer_index(w.buffer);
        let selected = id == self.selected_window;
        let b = &mut self.buffers[index];
        let line = b.line_of(pos.min(b.len()));
        if selected {
            b.top_line = line;
        } else {
            let start = b.line_start(line);
            b.set_window_start(id, start);
        }
        Ok(())
    }

    /// The selected frame's windows as they are now, to put back with
    /// [`Editor::set_window_configuration`], as Emacs's
    /// `current-window-configuration`. Returns its id; free it with
    /// [`Editor::free_window_configuration`].
    pub fn current_window_configuration(&mut self) -> u64 {
        let selected = self.selected_window;
        let mut windows = Vec::new();
        for id in self.window_tree.leaves() {
            let Some(w) = self.window(id) else { continue };
            let (buffer, width, height) = (w.buffer, w.width, w.height);
            let (parameters, dedicated, next_buffers) = (w.parameters.clone(), w.dedicated.clone(), w.next_buffers.clone());
            let prev_buffers = w
                .prev_buffers
                .iter()
                .filter_map(|&b| {
                    let (start, point) = self.buffers[self.buffer_with_id(b)?].prev_entry(id)?;
                    Some((b, start, point))
                })
                .collect();
            let start_pos = self.window_start(id).unwrap_or(0);
            let index = self.buffer_index(buffer);
            let b = &mut self.buffers[index];
            let point_pos = if id == selected { b.point() } else { b.window_point(id).unwrap_or(b.point()) };
            let (start, point) = (b.make_marker(start_pos, false), b.make_marker(point_pos, false));
            windows.push(SavedWindow { id, buffer, start, point, width, height, parameters, dedicated, prev_buffers, next_buffers });
        }
        let current = self.buffers[self.current].id;
        self.next_window_configuration += 1;
        let id = self.next_window_configuration;
        let minibuffer_selected = self.minibuffer_window_selected;
        let saved = WindowConfiguration { frame: self.selected_frame, tree: self.window_tree.clone(), selected, current, minibuffer_selected, windows };
        self.window_configurations.insert(id, saved);
        id
    }

    /// Puts a frame's windows back as a configuration had them, as Emacs's
    /// `set-window-configuration`: deleted windows come back, others go,
    /// each shows its buffer from where it started with its point, a
    /// buffer killed meanwhile replaced by another, and the buffer current
    /// then is current again if it is live. Point in that buffer is left
    /// where it is now, as Emacs leaves it. Returns false, doing nothing,
    /// if the configuration's frame is gone.
    pub fn set_window_configuration(&mut self, id: u64) -> Result<bool> {
        let config = self.window_configurations.get(&id).ok_or_else(|| Error::new("No such window configuration"))?;
        if !self.frame_order.contains(&config.frame) {
            return Ok(false);
        }
        if config.frame != self.selected_frame {
            self.select_frame(config.frame)?;
        }
        let config = self.window_configurations.get(&id).expect("checked");
        let (tree, selected, current, minibuffer_selected) = (config.tree.clone(), config.selected, config.current, config.minibuffer_selected);
        // Where point is now in the buffer current then, to leave it there.
        let old_point = self.buffer_with_id(current).map(|i| self.buffers[i].point());
        type Place = Option<(String, usize)>;
        let saved: Vec<(WindowId, u64, Place, Place, usize, usize)> = config
            .windows
            .iter()
            .map(|w| (w.id, w.buffer, self.marker_position(w.start).map(|(n, p)| (n.to_string(), p)), self.marker_position(w.point).map(|(n, p)| (n.to_string(), p)), w.width, w.height))
            .collect();
        let extras: Vec<_> = config.windows.iter().map(|w| (w.parameters.clone(), w.dedicated.clone(), w.prev_buffers.clone(), w.next_buffers.clone())).collect();
        // The selected window's point and start go to its buffer first, as
        // they would on selecting another.
        let old = self.selected_window;
        let shown = self.selected_buffer_index();
        let b = &mut self.buffers[shown];
        let (point, top) = (b.point(), b.line_start(b.top_line.min(b.line_count() - 1)));
        b.set_window_point(old, point);
        b.set_window_start(old, top);
        // Windows the configuration does not have go.
        let keep: Vec<WindowId> = saved.iter().map(|w| w.0).collect();
        for w in self.window_tree.leaves() {
            if !keep.contains(&w) {
                self.forget_window(w);
            }
        }
        let fallback = self.other_buffer().and_then(|n| self.find_buffer(n)).unwrap_or(0);
        for ((id, buffer, start, point, width, height), (parameters, dedicated, prev, next)) in saved.into_iter().zip(extras) {
            let index = self.buffer_with_id(buffer).unwrap_or(fallback);
            let buffer = self.buffers[index].id;
            if let Some(w) = self.window(id) {
                let old = self.buffer_index(w.buffer);
                self.buffers[old].remove_window_point(id);
                self.buffers[old].remove_window_start(id);
            } else {
                self.windows.push(Window::new(id, buffer, width, height));
            }
            let w = self.window_mut(id).expect("there now");
            w.buffer = buffer;
            (w.width, w.height) = (width, height);
            (w.parameters, w.dedicated, w.next_buffers) = (parameters, dedicated, next);
            // An entry the window still has has followed edits since; one
            // it dropped comes back as it was.
            let mut entries = Vec::new();
            for (b, start, point) in prev {
                let Some(i) = self.buffer_with_id(b) else { continue };
                let b = &mut self.buffers[i];
                if b.prev_entry(id).is_none() {
                    b.set_prev_entry(id, start.min(b.len()), point.min(b.len()));
                }
                entries.push(b.id);
            }
            self.window_mut(id).expect("there now").prev_buffers = entries;
            let at = |m: Option<(String, usize)>, b: &Buffer| m.filter(|(n, _)| *n == b.name).map_or(0, |(_, p)| p.min(b.len()));
            let b = &mut self.buffers[index];
            let (start, point) = (at(start, b), at(point, b));
            b.set_window_start(id, b.line_start(b.line_of(start)));
            b.set_window_point(id, point);
        }
        self.window_tree = tree;
        // As selecting it: its point and start become its buffer's.
        self.selected_window = selected;
        let w = self.window(selected).ok_or_else(|| Error::new("No such window"))?;
        let index = self.buffer_index(w.buffer);
        let b = &mut self.buffers[index];
        if let Some(point) = b.remove_window_point(selected) {
            b.set_point(point);
        }
        let top = b.remove_window_start(selected).map_or(0, |p| b.line_of(p));
        b.top_line = top.min(b.line_count() - 1);
        self.current = self.buffer_with_id(current).unwrap_or(index);
        if let Some(point) = old_point {
            self.buffers[self.current].set_point(point);
        }
        self.minibuffer_window_selected = minibuffer_selected && self.in_minibuffer();
        self.relayout();
        Ok(true)
    }

    /// Lets a configuration go, with its markers.
    pub fn free_window_configuration(&mut self, id: u64) {
        if let Some(config) = self.window_configurations.remove(&id) {
            for w in config.windows {
                self.delete_marker(w.start);
                self.delete_marker(w.point);
            }
        }
    }

    pub fn window_configuration_p(&self, id: u64) -> bool {
        self.window_configurations.contains_key(&id)
    }

    /// Feeds a mouse button event, such as `<mouse-1>` or `S-<drag-mouse-1>`,
    /// that happened where `event` says. It runs whatever the key is bound
    /// to, which reads the event with [`Editor::last_mouse_event`].
    pub fn mouse(&mut self, key: crate::key::Key, event: MouseEvent) {
        self.last_mouse = Some(event);
        self.tab_bar_column = None;
        self.handle_key(key);
    }

    /// Feeds a click of a mouse button, such as `<mouse-1>`, on a frame's
    /// tab bar `column` columns from its left, as Emacs's
    /// `<tab-bar> <mouse-1>`: the frame is selected, and the command bound
    /// to it reads the column as the last mouse event's `tab_bar`.
    pub fn tab_bar_mouse(&mut self, frame: FrameId, column: usize, key: crate::key::Key) {
        if self.select_frame(frame).is_err() {
            return;
        }
        self.last_mouse = Some(MouseEvent { window: self.selected_window, position: None, start: None });
        self.tab_bar_column = Some(column);
        self.handle_key(crate::key::Key::new(crate::key::KeyCode::TabBar));
        self.handle_key(key);
    }

    /// The tab bar column the last mouse event was on, if it was on a tab bar.
    pub fn last_mouse_tab_bar_column(&self) -> Option<usize> {
        self.tab_bar_column
    }

    /// A frame's parameter, as Emacs's `frame-parameter`: one code set, or
    /// `tab-bar-lines`, 0 unless set.
    pub fn frame_parameter(&self, frame: FrameId, name: &str) -> Option<Value> {
        self.frame_parameters.get(&frame).and_then(|p| p.get(name)).cloned()
    }

    /// Sets a frame's parameter, as Emacs's `set-frame-parameter`. Setting
    /// `tab-bar-lines` shows or hides the frame's tab bar, which takes
    /// lines from its windows.
    pub fn set_frame_parameter(&mut self, frame: FrameId, name: &str, value: Value) -> Result<()> {
        if !self.frame_order.contains(&frame) {
            return Err(Error::new("No such frame"));
        }
        self.frame_parameters.entry(frame).or_default().insert(name.to_string(), value);
        Ok(())
    }

    /// How many lines a frame's tab bar takes: its `tab-bar-lines`, 0 or 1.
    pub fn tab_bar_lines(&self, frame: FrameId) -> usize {
        match self.frame_parameter(frame, "tab-bar-lines") {
            Some(Value::Number(n)) if n >= 1.0 => 1,
            _ => 0,
        }
    }

    /// A frame's tab bar as the last redisplay formatted it, from its
    /// `tab-bar-line` parameter, a mode line construct, if it shows one.
    pub fn tab_bar(&self, frame: FrameId) -> Option<&[crate::modeline::ModeLineSegment]> {
        self.tab_bars.get(&frame).map(Vec::as_slice)
    }

    /// The frame a window is on, as Emacs's `window-frame`: the minibuffer's
    /// window is the selected frame's. None for no such window.
    pub fn window_frame(&self, window: WindowId) -> Option<FrameId> {
        if window == MINIBUFFER_WINDOW || self.window_tree.leaves().contains(&window) {
            return Some(self.selected_frame);
        }
        self.other_frames.iter().find(|f| f.tree.leaves().contains(&window)).map(|f| f.id)
    }

    /// A frame's first window, its top left one, as Emacs's `frame-first-window`.
    pub fn frame_first_window(&self, frame: FrameId) -> Option<WindowId> {
        self.frame_tree(frame).and_then(|t| t.leaves().first().copied())
    }

    /// The frames after and before one in `frame-list`'s order, round the
    /// end, as Emacs's `next-frame` and `previous-frame`.
    pub fn next_frame(&self, frame: FrameId, forward: bool) -> Option<FrameId> {
        let k = self.frame_order.iter().position(|f| *f == frame)?;
        let n = self.frame_order.len();
        Some(self.frame_order[if forward { (k + 1) % n } else { (k + n - 1) % n }])
    }

    /// Windows in cyclic order starting with one, the selected window by
    /// default, as Emacs's `window-list-1`: those of its frame, or of every
    /// frame with `all_frames`, the minibuffer's window after them with
    /// `minibuffer`.
    pub fn window_list_1(&self, window: Option<WindowId>, minibuffer: bool, all_frames: bool) -> Vec<WindowId> {
        let start = window.unwrap_or(self.selected_window);
        let frame = self.window_frame(start).unwrap_or(self.selected_frame);
        let frames: Vec<FrameId> = if all_frames {
            // The window's frame first, then the others in frame-list order after it.
            let k = self.frame_order.iter().position(|f| *f == frame).unwrap_or(0);
            self.frame_order[k..].iter().chain(&self.frame_order[..k]).copied().collect()
        } else {
            vec![frame]
        };
        let mut list: Vec<WindowId> = frames.iter().filter_map(|f| self.frame_tree(*f)).flat_map(WindowTree::leaves).collect();
        // The minibuffer's window comes after the selected frame's windows,
        // as each Emacs frame's after its own.
        if minibuffer {
            let selected = self.frame_tree(self.selected_frame).map_or(0, |t| t.leaves().len());
            let before: usize = frames.iter().take_while(|f| **f != self.selected_frame).filter_map(|f| self.frame_tree(*f)).map(|t| t.leaves().len()).sum();
            let at = if frames.contains(&self.selected_frame) { before + selected } else { list.len() };
            list.insert(at, MINIBUFFER_WINDOW);
        }
        if let Some(k) = list.iter().position(|w| *w == start) {
            list.rotate_left(k);
        }
        list
    }

    /// A frame's visibility, as Emacs's `frame-visible-p`: its `visibility`
    /// parameter, t unless made invisible (nil) or iconified (`icon`).
    pub fn frame_visibility(&self, frame: FrameId) -> Value {
        self.frame_parameter(frame, "visibility").unwrap_or(Value::Bool(true))
    }

    /// Shows a frame, hides it, or iconifies it, as Emacs's
    /// `make-frame-visible`, `make-frame-invisible` and `iconify-frame`:
    /// its `visibility` parameter, which a front end follows.
    /// The only frame shown or iconified cannot be hidden, as in Emacs.
    pub fn set_frame_visibility(&mut self, frame: FrameId, visibility: Value) -> Result<()> {
        if !visibility.is_true() && self.frame_order.iter().all(|f| *f == frame || !self.frame_visibility(*f).is_true()) {
            return Err(Error::new("Attempt to make invisible the sole visible or iconified frame"));
        }
        self.set_frame_parameter(frame, "visibility", visibility)
    }

    /// Asks the front end to bring a frame in front of the others, as
    /// Emacs's `raise-frame`, showing it if it was hidden or iconified.
    pub fn raise_frame(&mut self, frame: FrameId) -> Result<()> {
        self.set_frame_visibility(frame, Value::Bool(true))?;
        *self.frame_raises.entry(frame).or_insert(0) += 1;
        Ok(())
    }

    /// How many times a frame has been raised, for a front end to see a new request.
    pub fn frame_raises(&self, frame: FrameId) -> u64 {
        self.frame_raises.get(&frame).copied().unwrap_or(0)
    }

    /// Whether a window shows a mode line: its buffer's `mode-line-format`
    /// is not nil, and it is not the minibuffer's.
    pub fn window_shows_mode_line(&self, id: WindowId) -> bool {
        let Some(w) = self.window(id) else { return false };
        let b = &self.buffers[self.buffer_index(w.buffer)];
        self.variable_in(b, "mode-line-format").is_some_and(|v| v.is_true())
    }

    /// A window's total size in lines and columns, its mode line, header
    /// line and divider included, as `window-total-height` and `-width`
    /// count them.
    pub fn window_total_size(&self, id: WindowId) -> Option<(usize, usize)> {
        if let Some(&(_, cols, lines)) = self.window_total_sizes().iter().find(|(w, ..)| *w == id) {
            return Some((cols, lines));
        }
        let w = self.window(id)?;
        let lines = w.height + usize::from(self.window_shows_mode_line(id)) + usize::from(self.window_wants_header_line(id, w.height + 2));
        Some((w.width, lines))
    }

    /// A window's total size in the front end's units, pixels or cells, as
    /// `window-pixel-width` and `window-pixel-height`: its total columns and
    /// lines at the default font's size.
    pub fn window_pixel_size(&self, id: WindowId) -> Option<(f32, f32)> {
        if id == MINIBUFFER_WINDOW {
            let m = self.text_metrics();
            return Some((self.frame_cells().0 as f32 * m.char_width(), self.mini_window_lines() as f32 * m.char_height()));
        }
        let (cols, lines) = self.window_total_size(id)?;
        let m = self.text_metrics();
        Some((cols as f32 * m.char_width(), lines as f32 * m.char_height()))
    }

    /// A frame's selected window.
    pub fn frame_selected_window(&self, frame: FrameId) -> Option<WindowId> {
        if frame == self.selected_frame {
            return Some(self.selected_window);
        }
        self.other_frames.iter().find(|f| f.id == frame).map(|f| f.selected_window)
    }

    /// A frame's width in columns, as Emacs's `frame-width`.
    pub fn frame_width(&self, frame: FrameId) -> usize {
        if frame == self.selected_frame {
            return self.frame_cells().0;
        }
        self.other_frames.iter().find(|f| f.id == frame).and_then(|f| f.frame_size).map_or(self.frame_cells().0, |s| s.0)
    }

    pub fn last_mouse_event(&self) -> Option<MouseEvent> {
        self.last_mouse
    }

    /// Runs `f` with a window selected, then selects the one that was, as
    /// Emacs's `with-selected-window`.
    pub(crate) fn with_selected_window<T>(&mut self, id: WindowId, f: impl FnOnce(&mut Editor) -> T) -> T {
        let old = self.selected_window;
        if id == old || self.select_window_norecord(id).is_err() {
            return f(self);
        }
        let result = f(self);
        let _ = self.select_window_norecord(old);
        result
    }

    /// Text lines in the selected window.
    pub(crate) fn selected_window_height(&self) -> usize {
        self.window(self.selected_window).map_or(24, |w| w.height)
    }

    pub(crate) fn set_selected_window_height(&mut self, lines: usize) {
        let selected = self.selected_window;
        if let Some(w) = self.window_mut(selected) {
            w.height = lines.max(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_halve_and_odd_sizes_go_first() {
        let mut tree = WindowTree::Leaf(1);
        tree.split(1, 2, false, false, None);
        tree.split(1, 3, true, false, None);
        assert_eq!(tree.leaves(), [1, 3, 2]);
        let rects = tree.rects(0.0, 0.0, 81.0, 25.0, (1.0, 1.0));
        let size = |r: &WindowRect| (r.id, r.x, r.y, r.width, r.height, r.divider);
        assert_eq!(
            rects.iter().map(size).collect::<Vec<_>>(),
            [(1, 0.0, 0.0, 41.0, 13.0, true), (3, 41.0, 0.0, 40.0, 13.0, false), (2, 0.0, 13.0, 81.0, 12.0, false)]
        );
        tree.remove(1);
        assert_eq!(tree.leaves(), [3, 2]);
        tree.remove(2);
        assert_eq!(tree, WindowTree::Leaf(3));
    }

    #[test]
    fn a_split_before_puts_the_new_window_first_at_its_size() {
        let mut tree = WindowTree::Leaf(1);
        tree.split(1, 2, true, true, Some(30));
        assert_eq!(tree.leaves(), [2, 1]);
        let rects = tree.rects(0.0, 0.0, 80.0, 24.0, (1.0, 1.0));
        let size = |r: &WindowRect| (r.id, r.x, r.width);
        assert_eq!(rects.iter().map(size).collect::<Vec<_>>(), [(2, 0.0, 30.0), (1, 30.0, 50.0)]);
    }
}
