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

pub use crate::window_tree::{Combination, Part, WindowRect, WindowTree};
use crate::window_tree::{WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH};

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
    /// The fringe widths `set-window-fringes` gave it, in the front end's
    /// units, with the buffer they were set for unless they are to stay
    /// whatever it shows, and whether they go outside its margins.
    pub(crate) fringes: Option<WindowFringeWidths>,
    /// What `set-window-scroll-bars` was told, which E8 keeps and gives
    /// back, drawing no scroll bars: the vertical kind and the horizontal.
    pub(crate) scroll_bars: Option<(Value, Value, bool)>,
    /// What the window was at the last redisplay, for `window-old-buffer`
    /// and its kin.
    pub(crate) old: Option<OldWindow>,
    /// Whether its cursor is drawn, as `internal-show-cursor` sets it.
    pub(crate) cursor_shown: bool,
    /// What its cursor looks like, as `set-window-cursor-type` gave it.
    pub(crate) cursor_type: Option<Value>,
    /// How far it is scrolled horizontally.
    pub(crate) hscroll: crate::scroll::Hscroll,
    /// How far it is scrolled up past its start, in the front end's units.
    pub(crate) vscroll: crate::scroll::Vscroll,
    /// The buffer `window-scroll-functions` last ran for, and a marker in
    /// it at the start they ran for, which edits move as they move the text.
    pub(crate) scrolled_to: Option<(u64, u64)>,
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
            fringes: None,
            scroll_bars: None,
            old: None,
            cursor_shown: true,
            cursor_type: None,
            hscroll: Default::default(),
            vscroll: Default::default(),
            scrolled_to: None,
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
    hscroll: crate::scroll::Hscroll,
    /// Its margins, fringes and scroll bars, which save_window_save
    /// keeps and set-window-configuration puts back.
    margins: Option<(u64, usize, usize)>,
    fringes: Option<WindowFringeWidths>,
    scroll_bars: Option<(Value, Value, bool)>,
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

/// A window's sizes as window.el sets them to apply together, as window.c's
/// new_pixel, new_total and new_normal: unset, each is the window's own.
/// A new normal size of `Some(None)` is nil, as window--resize-reset makes it.
#[derive(Clone, Debug, Default)]
pub struct WindowNew {
    pub pixel: Option<i64>,
    pub total: Option<i64>,
    pub normal: Option<Option<f64>>,
}

/// What a window was at the last redisplay, as Emacs keeps a window's
/// old buffer, point and sizes for `window-state-change-functions`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct OldWindow {
    pub(crate) buffer: u64,
    pub(crate) point: usize,
    /// Its whole size and its text area's, in the front end's units.
    pub(crate) pixel: (usize, usize),
    pub(crate) body: (usize, usize),
}

/// The fringe widths a window was given, in the front end's units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WindowFringeWidths {
    /// The buffer they were set for, or none to keep them whatever the
    /// window shows, as `set-window-fringes`'s PERSISTENT says.
    pub(crate) buffer: Option<u64>,
    pub(crate) left: Option<f32>,
    pub(crate) right: Option<f32>,
    pub(crate) outside_margins: bool,
}

/// A frame that is not selected: its windows and which of them was
/// selected in it. The selected frame's are the editor's own.
pub(crate) struct Frame {
    pub(crate) id: FrameId,
    tree: WindowTree,
    selected_window: WindowId,
    frame_size: Option<(usize, usize)>,
    frame_size_implied: bool,
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

    pub(crate) fn window_mut(&mut self, id: WindowId) -> Option<&mut Window> {
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
        self.other_frames.push(Frame { id, tree: WindowTree::Leaf(window), selected_window: window, frame_size: self.frame_size, frame_size_implied: self.frame_size_implied });
        self.frame_order.insert(0, id);
        // A new frame shows a menu bar if the others do, as Emacs's
        // `menu-bar-mode` puts `menu-bar-lines` in `default-frame-alist`
        // so that frames made later have one.
        let lines = self.menu_bar_lines(self.selected_frame);
        if lines > 0 {
            self.frame_parameters.entry(id).or_default().insert("menu-bar-lines".to_string(), Value::Number(lines as f64));
        }
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
        // A frame that sent its keys to the frame that was selected sends
        // them to this one now, as do_switch_frame moves a redirection,
        // so a frame borrowing a minibuffer borrows the one in front.
        let was = self.selected_frame;
        self.follow_selected_frame(was, id);
        self.other_frames.push(Frame {
            id: self.selected_frame,
            tree: std::mem::replace(&mut self.window_tree, frame.tree),
            selected_window: std::mem::replace(&mut self.selected_window, frame.selected_window),
            frame_size: std::mem::replace(&mut self.frame_size, frame.frame_size),
            frame_size_implied: std::mem::replace(&mut self.frame_size_implied, frame.frame_size_implied),
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
        self.frame_geometries.remove(&id);
        self.frame_focus.remove(&id);
        self.frame_focus.retain(|_, to| *to != id);
        self.frame_state_changes.retain(|f| *f != id);
        if self.old_selected_frame == Some(id) {
            self.old_selected_frame = None;
        }
        self.tab_bars.remove(&id);
        self.prune_internal_windows();
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
        let (cw, lh) = self.cell();
        self.set_frame_pixel_size((cols.max(1) as f32 * cw).round() as usize, (lines.max(1) as f32 * lh).round() as usize);
    }

    /// Tells the editor how big the frame's windows' part of it is in the
    /// front end's units, points in the GUI, as Emacs's root window's pixel
    /// size: the windows' sizes are kept in these units, and a new size is
    /// shared among them as their normal sizes say.
    pub fn set_frame_pixel_size(&mut self, width: usize, height: usize) {
        self.frame_size = Some((width.max(1), height.max(1)));
        self.frame_size_implied = false;
        self.relayout();
    }

    /// A column's width and a line's height in the front end's units, the
    /// default font's, as `frame-char-width` and `frame-char-height`.
    pub fn cell(&self) -> (f32, f32) {
        let m = self.text_metrics();
        (m.char_width().max(f32::EPSILON), m.char_height().max(f32::EPSILON))
    }

    /// The frame's windows' part in the front end's units: as a front end
    /// said, or as the selected window is.
    pub fn frame_units(&self) -> (usize, usize) {
        self.frame_size.unwrap_or_else(|| {
            let (cw, lh) = self.cell();
            let (cols, lines) = self.window(self.selected_window).map_or((80, 24), |w| (w.width, w.height + 1));
            ((cols as f32 * cw).round() as usize, (lines as f32 * lh).round() as usize)
        })
    }

    /// The smallest a live window may be across or down, in the front end's
    /// units: window-min-width columns and window-min-height lines, and
    /// room for what of it is not text and a line or two columns of it, as
    /// Emacs's `window-min-size` counts the mode line's height.
    pub(crate) fn window_min_units(&self, horizontal: bool) -> usize {
        let (cw, lh) = self.cell();
        let chrome = self.text_metrics().window_chrome();
        // window-min-width and window-min-height, as a script set them.
        let lines = |name: &str, default: usize| self.variable(name).and_then(|v| v.as_number()).map_or(default as f32, |n| n.max(0.0) as f32);
        let units = if horizontal {
            (lines("window-min-width", WINDOW_MIN_WIDTH) * cw).max(chrome.fringes + chrome.divider + 2.0 * cw)
        } else {
            (lines("window-min-height", WINDOW_MIN_HEIGHT) * lh).max(chrome.mode_line + chrome.text_top + lh)
        };
        units.round() as usize
    }

    /// The smallest a window may be made with an explicit size, in the
    /// front end's units, as window-safe-min-height and -width: a line and
    /// what of it is not text, or two columns.
    fn window_safe_min_units(&self, horizontal: bool) -> i64 {
        let (cw, lh) = self.cell();
        let chrome = self.text_metrics().window_chrome();
        let units = if horizontal { (2.0 * cw).max(chrome.fringes + cw) } else { (2.0 * lh).max(chrome.mode_line + chrome.text_top + lh) };
        units.round() as i64
    }

    /// A place in the front end's units as whole columns or lines from the
    /// frame's top left, rounded down, as the frame's own size is; edges so
    /// counted make windows' sizes add up to the frame's, as Emacs's
    /// window--pixel-to-total keeps them.
    fn to_cells(&self, units: f32, horizontal: bool) -> usize {
        let (cw, lh) = self.cell();
        // A hair's grace, so a size worked out as a product comes back whole.
        ((units + 0.001) / if horizontal { cw } else { lh }).floor() as usize
    }

    /// A window's total columns and lines, from its edges in cells.
    fn total_cells(&self, r: &WindowRect) -> (usize, usize) {
        (self.to_cells(r.x + r.width, true) - self.to_cells(r.x, true), self.to_cells(r.y + r.height, false) - self.to_cells(r.y, false))
    }

    /// Each window's total size, in columns with its divider and lines with
    /// its mode line, as Emacs's `window-total-width` and `-height`.
    pub fn window_total_sizes(&self) -> Vec<(WindowId, usize, usize)> {
        let (width, height) = self.frame_units();
        self.window_tree
            .rects(0.0, 0.0, width as f32, height as f32, (1.0, 1.0))
            .iter()
            .map(|r| {
                let (cols, lines) = self.total_cells(r);
                (r.id, cols, lines)
            })
            .collect()
    }

    /// A window's rectangle in its frame, in the front end's units, as
    /// `window-pixel-edges` gives it: internal windows too.
    pub fn window_pixel_rect(&self, id: WindowId) -> Option<WindowRect> {
        let frame = self.window_frame(id)?;
        let (width, height) = self.frame_units_of(frame);
        // The minibuffer's window lies below the frame's windows, as many lines as it shows.
        if id == MINIBUFFER_WINDOW {
            let lines = self.mini_window_lines() as f32 * self.cell().1;
            return Some(WindowRect { id, x: 0.0, y: height as f32, width: width as f32, height: lines, divider: false });
        }
        self.frame_tree(frame)?.all_rects(0.0, 0.0, width as f32, height as f32, (1.0, 1.0)).into_iter().find(|r| r.id == id)
    }

    /// A frame's windows' part in the front end's units.
    pub(crate) fn frame_units_of(&self, frame: FrameId) -> (usize, usize) {
        if frame == self.selected_frame {
            return self.frame_units();
        }
        self.other_frames.iter().find(|f| f.id == frame).and_then(|f| f.frame_size).unwrap_or_else(|| self.frame_units())
    }

    /// What of a window is not its text, in the front end's units: above
    /// its text (a header line, the space the front end leaves), below it
    /// (a mode line), and across (fringes, and a divider if a window is to
    /// its right).
    pub fn window_chrome_units(&self, id: WindowId, rect: &WindowRect) -> (f32, f32, f32) {
        let chrome = self.text_metrics().window_chrome();
        let lines = self.total_cells(rect).1;
        let header = if self.window_wants_header_line(id, lines) { chrome.header_line } else { 0.0 };
        let mode = if self.window_shows_mode_line(id) { chrome.mode_line } else { 0.0 };
        let (left, right, ..) = self.window_fringe_widths(id);
        let across = (left + right) as f32 + if rect.divider { chrome.divider } else { 0.0 };
        (header + chrome.text_top, mode, across)
    }

    /// A window's edges in its frame, in columns and lines from the frame's
    /// top left, as Emacs's `window-edges`: left, top, right and bottom,
    /// its mode line and divider included, or with `body` only its text
    /// area. The minibuffer's window is below the frame's windows.
    pub fn window_edges(&self, id: WindowId, body: bool) -> Option<(usize, usize, usize, usize)> {
        let frame = self.window_frame(id)?;
        if id == MINIBUFFER_WINDOW {
            let (width, height) = self.frame_units_of(frame);
            let (cols, lines) = (self.to_cells(width as f32, true), self.to_cells(height as f32, false));
            return Some((0, lines, cols, lines + self.mini_window_lines()));
        }
        let rect = self.window_pixel_rect(id)?;
        let (mut x0, mut y0, mut x1, mut y1) = (rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
        if body && self.window(id).is_some() {
            let (above, below, across) = self.window_chrome_units(id, &rect);
            // The window's own left fringe, as window-body-edges counts
            // from WINDOW_LEFT_FRINGE_WIDTH.
            let (left_fringe, ..) = self.window_fringe_widths(id);
            x0 += left_fringe as f32;
            x1 = (x1 - (across - left_fringe as f32)).max(x0);
            y0 += above;
            y1 = (y1 - below).max(y0);
        }
        Some((self.to_cells(x0, true), self.to_cells(y0, false), self.to_cells(x1, true), self.to_cells(y1, false)))
    }

    /// A size in the front end's units in cells, as the frame's own
    /// sizes are counted.
    pub fn units_to_cells(&self, units: f32, horizontal: bool) -> usize {
        self.to_cells(units, horizontal)
    }

    /// A frame's title, as the last redisplay formatted `frame-title-format`.
    pub fn frame_title(&self, frame: FrameId) -> Option<String> {
        self.frame_titles.get(&frame).cloned()
    }

    /// The frame in cells, without the echo area: as a front end said, or
    /// as the windows add up to.
    pub fn frame_cells(&self) -> (usize, usize) {
        let (width, height) = self.frame_units();
        (self.to_cells(width as f32, true), self.to_cells(height as f32, false))
    }

    /// Lays the windows out in the frame, as their sizes in the tree say:
    /// each window's text area, what is left of it beside its mode line,
    /// header line, fringes and divider, in whole columns and lines.
    fn relayout(&mut self) {
        let Some((width, height)) = self.frame_size else { return };
        self.window_tree.fit((width, height));
        let (cw, lh) = self.cell();
        for r in self.window_tree.rects(0.0, 0.0, width as f32, height as f32, (1.0, 1.0)) {
            let (above, below, across) = self.window_chrome_units(r.id, &r);
            if let Some(w) = self.window_mut(r.id) {
                w.width = (((r.width - across) / cw).floor() as usize).max(1);
                w.height = (((r.height - above - below) / lh).floor() as usize).max(1);
            }
        }
    }

    /// Grows a window by `delta` lines, or columns if `horizontal`, taking
    /// them from its neighbour; a negative delta shrinks it. As far as the
    /// windows' smallest sizes allow, as Emacs's `window-resize` with
    /// `window--resizable` does: returns how far it went, or with `apply`
    /// off, how far it could. With `pixelwise`, `delta` and what it gives
    /// are in the front end's units, as `window-resize`'s PIXELWISE.
    pub fn resize_window(&mut self, id: Option<WindowId>, delta: i64, horizontal: bool, apply: bool) -> Result<i64> {
        self.resize_window_by(id, delta, horizontal, apply, false)
    }

    pub fn resize_window_by(&mut self, id: Option<WindowId>, delta: i64, horizontal: bool, apply: bool, pixelwise: bool) -> Result<i64> {
        let id = id.unwrap_or(self.selected_window);
        if self.window(id).is_none() {
            return Err(Error::new("No such window"));
        }
        let unit = if horizontal { self.cell().0 } else { self.cell().1 };
        let delta_units = if pixelwise { delta } else { (delta as f32 * unit).round() as i64 };
        let extent = self.frame_units();
        let leaf = self.window_min_units(horizontal);
        let moved = self.window_tree.resize(id, delta_units, horizontal, extent, leaf, apply, false).unwrap_or(0);
        if apply {
            self.relayout();
        }
        Ok(if pixelwise { moved } else { (moved as f32 / unit).round() as i64 })
    }

    /// Moves a window's bottom edge, or its right edge if `horizontal`, by
    /// `delta` lines or columns, as dragging its mode line or divider does
    /// in Emacs. A window with nothing below or to its right stays as it is.
    pub fn move_window_edge(&mut self, id: WindowId, delta: i64, horizontal: bool) -> i64 {
        let unit = if horizontal { self.cell().0 } else { self.cell().1 };
        let moved = self.move_window_edge_by(id, (delta as f32 * unit).round() as i64, horizontal);
        (moved as f32 / unit).round() as i64
    }

    /// Moves a window's bottom or right edge by `delta` of the front end's
    /// units, as dragging with the mouse does, and gives how far it went.
    pub fn move_window_edge_by(&mut self, id: WindowId, delta: i64, horizontal: bool) -> i64 {
        let extent = self.frame_units();
        let leaf = self.window_min_units(horizontal);
        let moved = self.window_tree.resize(id, delta, horizontal, extent, leaf, true, true).unwrap_or(0);
        self.relayout();
        moved
    }

    /// Makes the windows the same size as their neighbours, as Emacs's
    /// `balance-windows`.
    pub fn balance_windows(&mut self) {
        let extent = self.frame_units();
        let cell = self.cell();
        self.window_tree.balance(extent, cell);
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
        // Unscrolled, even showing the same buffer again, as Emacs's set_window_buffer.
        let w_dedicated_refuses = w.buffer != self.buffers[index].id && w.dedicated == Value::Bool(true);
        if !w_dedicated_refuses {
            self.window_mut(id).expect("checked").hscroll = Default::default();
            self.reset_vscroll(id);
        }
        let w = self.window(id).expect("checked");
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

    /// Marks a window the second most recently used, after the selected
    /// one, as Emacs's `window-bump-use-time`; gives its use time, or None
    /// for the selected window, which is left as it is.
    pub fn window_bump_use_time(&mut self, id: WindowId) -> Option<u64> {
        if id == self.selected_window || self.window(id).is_none() {
            return None;
        }
        self.window_use += 1;
        let used = self.window_use;
        self.window_mut(id).expect("checked").used = used;
        self.window_use += 1;
        let selected_used = self.window_use;
        let selected = self.selected_window;
        if let Some(w) = self.window_mut(selected) {
            w.used = selected_used;
        }
        Some(used)
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
        if !self.window_tree.leaves().contains(&id) {
            return Err(Error::new("No such window"));
        }
        self.split_node(id, side_by_side, before, size)
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
        let root = self.window_tree.id();
        self.split_node(root, side_by_side, before, size)
    }

    fn split_node(&mut self, id: WindowId, side_by_side: bool, before: bool, size: Option<i64>) -> Result<WindowId> {
        let extent = self.frame_units();
        let live = self.window(id).is_some();
        let (total_width, total_height) = self.window_tree.extent_of(id, extent).ok_or_else(|| Error::new("No such window"))?;
        // Sizes are the front end's units; SIZE and the minimum sizes are
        // lines or columns of the default font, as split-window counts them
        // when windows are not resized pixelwise.
        let unit = if side_by_side { self.cell().0 } else { self.cell().1 };
        let total_units = if side_by_side { total_width } else { total_height } as i64;
        let total = (total_units as f32 / unit).floor() as i64;
        let units = |lines: i64| ((lines as f32 * unit).round() as i64).min(total_units);
        let min_units = self.window_min_units(side_by_side) as i64;
        let safe = self.window_safe_min_units(side_by_side);
        // An explicit size only has to leave each window its safe minimum,
        // as window-safe-min-height and -width give: a line and the mode
        // line, or two columns. Halved, the old window keeps an odd line or
        // column, before or after, and what is left of a unit.
        let (old, new) = match size {
            None if total_units < 2 * min_units => {
                let name = if live { format!("#<window {id} on {}>", self.window_buffer_name(id).unwrap_or_default()) } else { format!("#<window {id}>") };
                return Err(Error::new(format!("Window {name} too small for splitting")));
            }
            None => (total_units - units(total / 2), units(total / 2)),
            Some(size) => {
                let (old, new) = if size >= 0 { (units(size), total_units - units(size)) } else { (total_units - units(-size), units(-size)) };
                if new < safe {
                    return Err(Error::new("Size of new window too small"));
                }
                if old < safe {
                    return Err(Error::new("Size of window too small"));
                }
                (old, new)
            }
        };
        // Sizes are kept in the frame's units, which a front end gives; until one has, the frame is as the windows are now.
        if self.frame_size.is_none() {
            self.frame_size = Some(extent);
            self.frame_size_implied = true;
        }
        // As split-window: a side window is split only for its side's slots
        // (window-combination-resize `side'), and a window beside a side
        // window gets an internal window of its own, so the side window
        // stays along the whole side.
        let resize_side = self.variable("window-combination-resize").is_some_and(|v| v.as_str() == Some("side"));
        let has_side = |ed: &Editor, w: Option<WindowId>| w.is_some_and(|w| ed.window_parameter(w, "window-side").is_some_and(|v| v.is_true()));
        if !resize_side && has_side(self, Some(id)) {
            return Err(Error::new("Cannot split side window or parent of side window"));
        }
        let beside_side = !resize_side && (has_side(self, self.window_sibling(id, false)) || has_side(self, self.window_sibling(id, true)));
        let limit = beside_side || self.variable("window-combination-limit") == Some(Value::Bool(true));
        let source = if live { id } else { self.selected_window };
        let view = self.windows().into_iter().find(|v| v.id == source).map(|v| (v.point, v.top_line, v.buffer.id)).ok_or_else(|| Error::new("No such window"))?;
        // The internal window, if one is made, is numbered before the new window, as in Emacs.
        let internal = if self.window_tree.split_makes_parent(id, side_by_side, limit) {
            self.next_window_id += 1;
            self.next_window_id
        } else {
            0
        };
        self.next_window_id += 1;
        let new_id = self.next_window_id;
        // A new window has showed no buffers before, as in Emacs.
        self.windows.push(Window::new(new_id, view.2, 1, 1));
        self.forget_new_sizes();
        let index = self.buffer_index(view.2);
        let b = &mut self.buffers[index];
        b.set_window_point(new_id, view.0);
        let start = b.line_start(view.1.min(b.line_count() - 1));
        b.set_window_start(new_id, start);
        self.window_tree.split(&crate::window_tree::Split {
            target: id,
            new: new_id,
            internal,
            horizontal: side_by_side,
            before,
            old_size: old as usize,
            new_size: new as usize,
            limit,
        });
        self.relayout();
        Ok(new_id)
    }

    /// Deletes a window, giving its space to its neighbour, as Emacs's
    /// `delete-window`. If it was selected, the most recently used window
    /// left is selected.
    pub fn delete_window(&mut self, id: Option<WindowId>) -> Result<()> {
        let id = id.unwrap_or(self.selected_window);
        // Only the selected frame's windows count; an internal window goes with all it holds, as in Emacs.
        let inside = match self.window_tree.node(id) {
            Some(node) if id != MINIBUFFER_WINDOW => node.leaves(),
            _ => return Err(Error::new("No such window")),
        };
        let leaves = self.window_tree.leaves();
        if inside.len() == leaves.len() {
            return Err(Error::new("Attempt to delete minibuffer or sole ordinary window"));
        }
        if inside.contains(&self.selected_window) {
            let next = self
                .windows
                .iter()
                .filter(|w| !inside.contains(&w.id) && leaves.contains(&w.id))
                .max_by_key(|w| w.used)
                .map(|w| w.id)
                .expect("another window");
            self.select_window_norecord(next)?;
        }
        for &w in &inside {
            self.forget_window(w);
        }
        let internal: Vec<WindowId> = self.window_tree.node(id).map(|n| n.ids()).unwrap_or_default();
        for gone in self.window_tree.remove(id).into_iter().chain(internal) {
            self.internal_window_parameters.remove(&gone);
        }
        self.prune_internal_windows();
        self.relayout();
        Ok(())
    }

    /// Splits a window of the selected frame, live or internal, as
    /// window.c's `split-window-internal`, which window.el's
    /// `split-window` calls once it has worked out the sizes: the new
    /// window is `pixel_size` units along the split, below, above, left or
    /// right of `old` as `side` says, with `normal` as its normal size.
    /// `old` takes the new pixel size window.el gave it, or, when the
    /// split takes from its siblings (`window-combination-resize`), they
    /// take theirs; an internal window holding the two is made unless
    /// `old`'s parent combines windows that way and
    /// `window-combination-limit` is not t. The new window shows `old`'s
    /// buffer at its place, or the selected window's for an internal one.
    pub fn split_window_internal(&mut self, old: WindowId, pixel_size: i64, side: &str, normal: Option<f64>) -> Result<WindowId> {
        if old == MINIBUFFER_WINDOW {
            return Err(Error::new("Attempt to split minibuffer window"));
        }
        if !self.window_tree.contains(old) {
            return Err(Error::new("No such window"));
        }
        let horizontal = matches!(side, "right" | "left");
        let before = matches!(side, "above" | "left");
        let (cw, lh) = self.cell();
        let least = if horizontal { (2.0 * cw).round() } else { lh.round() } as i64;
        if pixel_size < least.max(1) {
            return Err(Error::new("Size of new window too small (after split)"));
        }
        // Sizes are kept in the frame's units, which a front end gives; until one has, the frame is as the windows are now.
        if self.frame_size.is_none() {
            self.frame_size = Some(self.frame_units());
            self.frame_size_implied = true;
        }
        let parent = self.window_tree.parent(old).map(|(c, _)| (c.id, c.horizontal));
        let var_limit = self.variable("window-combination-limit") == Some(Value::Bool(true));
        let limit = var_limit || parent.is_none_or(|(_, h)| h != horizontal);
        let new_along = |ed: &Editor, id: WindowId| ed.window_new.get(&id).and_then(|n| n.pixel).or_else(|| ed.window_pixel_along(id, horizontal)).unwrap_or(0);
        let old_px = self.window_pixel_along(old, horizontal).ok_or_else(|| Error::new("No such window"))?;
        let resize = !limit && self.variable("window-combination-resize").is_some_and(|v| v.is_true());
        if let (true, Some((p, _))) = (resize, parent) {
            let children = self.window_children(p).map(|c| c.1).unwrap_or_default();
            let sum: i64 = children.iter().map(|&c| new_along(self, c)).sum();
            if sum + pixel_size != self.window_pixel_along(p, horizontal).unwrap_or(0) {
                return Err(Error::new("Window sizes don't fit"));
            }
        } else if new_along(self, old) + pixel_size != old_px {
            return Err(Error::new("Sum of sizes of old and new window don't fit"));
        }
        let source = if self.window(old).is_some() { old } else { self.selected_window };
        let view = self.windows().into_iter().find(|v| v.id == source).map(|v| (v.point, v.top_line, v.buffer.id)).ok_or_else(|| Error::new("No such window"))?;
        let backup = self.window_tree.clone();
        // The internal window, if one is made, is numbered before the new window, as in Emacs.
        let internal = if limit {
            self.next_window_id += 1;
            self.next_window_id
        } else {
            0
        };
        self.next_window_id += 1;
        let new_id = self.next_window_id;
        self.window_tree.split(&crate::window_tree::Split {
            target: old,
            new: new_id,
            internal,
            horizontal,
            before,
            old_size: if resize { old_px } else { old_px - pixel_size } as usize,
            new_size: pixel_size as usize,
            limit: var_limit,
        });
        // A new window has showed no buffers before, as in Emacs.
        self.windows.push(Window::new(new_id, view.2, 1, 1));
        let new = self.window_new.entry(new_id).or_default();
        new.pixel = Some(pixel_size);
        new.normal = Some(normal);
        if !self.window_resize_apply(self.selected_frame, horizontal) {
            self.window_tree = backup;
            self.windows.retain(|w| w.id != new_id);
            self.window_new.remove(&new_id);
            self.relayout();
            return Err(Error::new("Window sizes don't fit"));
        }
        self.forget_new_sizes();
        let index = self.buffer_index(view.2);
        let b = &mut self.buffers[index];
        b.set_window_point(new_id, view.0);
        let start = b.line_start(view.1.min(b.line_count() - 1));
        b.set_window_start(new_id, start);
        self.relayout();
        Ok(new_id)
    }

    /// Deletes a window of the selected frame, live or internal, as
    /// window.c's `delete-window-internal`, which window.el's
    /// `delete-window` calls once it has given the window's siblings their
    /// new pixel sizes: they take them, failing if they do not fill the
    /// parent. An internal window left with one child is replaced by it.
    /// If the selected window goes, the frame's first window is selected,
    /// leaving the buffer list as it is.
    pub fn delete_window_internal(&mut self, id: WindowId) -> Result<()> {
        if id == MINIBUFFER_WINDOW || !self.window_tree.contains(id) {
            return Err(Error::new("No such window"));
        }
        let Some(horizontal) = self.window_tree.parent(id).map(|(c, _)| c.horizontal) else {
            return Err(Error::new("Attempt to delete minibuffer or sole ordinary window"));
        };
        let node = self.window_tree.node(id).expect("checked");
        let (inside, internal) = (node.leaves(), node.ids());
        let backup = self.window_tree.clone();
        let gone = self.window_tree.remove(id);
        if !self.window_resize_apply(self.selected_frame, horizontal) {
            self.window_tree = backup;
            self.relayout();
            return Err(Error::new("Deletion failed"));
        }
        self.forget_new_sizes();
        if inside.contains(&self.selected_window) {
            // Selected as select-window with NORECORD, which in Emacs leaves its use time as it was.
            let first = self.window_tree.leaves()[0];
            let used = self.window(first).map(|w| w.used);
            self.select_window_norecord(first)?;
            if let (Some(used), Some(w)) = (used, self.window_mut(first)) {
                w.used = used;
            }
        }
        for &w in &inside {
            self.forget_window(w);
        }
        for g in gone.into_iter().chain(internal) {
            self.internal_window_parameters.remove(&g);
        }
        self.prune_internal_windows();
        self.relayout();
        Ok(())
    }

    /// Forgets the selected frame's windows' new sizes once window.c's
    /// split or deletion has applied them, so each has its own again, as
    /// window--pixel-to-total leaves them in Emacs.
    fn forget_new_sizes(&mut self) {
        for id in self.window_tree.ids() {
            self.window_new.remove(&id);
        }
    }

    /// Makes a window fill `main`, the frame's root window by default,
    /// deleting the others in it, as window.c's
    /// `delete-other-windows-internal`: the window takes `main`'s place
    /// and size, its own windows keeping their proportions. If the
    /// selected window goes, the next in cyclic order inside the window is
    /// selected.
    pub fn delete_other_windows_internal(&mut self, window: Option<WindowId>, main: Option<WindowId>) -> Result<()> {
        let window = window.unwrap_or(self.selected_window);
        let main = main.unwrap_or(self.window_tree.id());
        let (Some(path), Some(main_path)) = (self.window_tree.path(window), self.window_tree.path(main)) else {
            return Err(Error::new("No such window"));
        };
        if !path.starts_with(&main_path) {
            return Err(Error::new("Specified root is not an ancestor of specified window"));
        }
        if window == main {
            return Ok(());
        }
        let kept = self.window_tree.node(window).expect("checked").ids();
        let all = self.window_tree.node(main).expect("checked").ids();
        let leaves = self.window_tree.leaves();
        let going: Vec<WindowId> = all.into_iter().filter(|w| !kept.contains(w)).collect();
        if going.contains(&self.selected_window) {
            // The last live window inside, as Emacs's delete-other-windows-internal selects.
            let next = leaves.iter().rev().copied().find(|w| kept.contains(w)).expect("a live window inside");
            self.select_window(next)?;
        }
        let extent = self.window_tree.extent_of(main, self.frame_units()).ok_or_else(|| Error::new("No such window"))?;
        self.window_tree.replace(main, window, extent);
        for &w in &going {
            if self.window(w).is_some() {
                self.forget_window(w);
            }
            self.internal_window_parameters.remove(&w);
        }
        self.prune_internal_windows();
        self.relayout();
        Ok(())
    }

    /// A window's size along `horizontal` in the front end's units, live or
    /// internal, as `window-pixel-width` and `-height`.
    pub fn window_pixel_along(&self, id: WindowId, horizontal: bool) -> Option<i64> {
        let r = self.window_pixel_rect(id)?;
        Some(if horizontal { r.width } else { r.height }.round() as i64)
    }

    /// A window's new pixel size, as `window-new-pixel`: its own height
    /// until one is set.
    pub fn window_new_pixel(&self, id: WindowId) -> Option<i64> {
        self.window_new.get(&id).and_then(|n| n.pixel).or_else(|| self.window_pixel_along(id, false))
    }

    /// Sets a window's new pixel size, or adds to it, as `set-window-new-pixel`.
    pub fn set_window_new_pixel(&mut self, id: WindowId, size: i64, add: bool) -> Result<i64> {
        let now = self.window_new_pixel(id).ok_or_else(|| Error::new("No such window"))?;
        let size = if add { now + size } else { size };
        if size < 0 {
            return Err(Error::signal("args-out-of-range", format!("Args out of range: {size}"), vec![Value::Number(size as f64)]));
        }
        self.window_new.entry(id).or_default().pixel = Some(size);
        Ok(size)
    }

    /// A window's new total size, in lines or columns, as `window-new-total`.
    pub fn window_new_total(&self, id: WindowId) -> Option<i64> {
        let (cols, lines) = self.window_total_size(id)?;
        let _ = cols;
        Some(self.window_new.get(&id).and_then(|n| n.total).unwrap_or(lines as i64))
    }

    /// Sets a window's new total size, or adds to it, as `set-window-new-total`.
    pub fn set_window_new_total(&mut self, id: WindowId, size: i64, add: bool) -> Result<i64> {
        let now = self.window_new_total(id).ok_or_else(|| Error::new("No such window"))?;
        let size = if add { now + size } else { size };
        if size < 0 {
            return Err(Error::signal("args-out-of-range", format!("Args out of range: {size}"), vec![Value::Number(size as f64)]));
        }
        self.window_new.entry(id).or_default().total = Some(size);
        Ok(size)
    }

    /// A window's new normal size, as `window-new-normal`: its normal size
    /// until one is set, and nil once window--resize-reset clears it.
    pub fn window_new_normal(&self, id: WindowId) -> Option<f64> {
        match self.window_new.get(&id).and_then(|n| n.normal) {
            Some(set) => set,
            None => self.window_normal_size(id, self.window_parent(id).and_then(|p| self.window_children(p)).is_some_and(|c| c.0)),
        }
    }

    /// Sets a window's new normal size, nil with none, as `set-window-new-normal`.
    pub fn set_window_new_normal(&mut self, id: WindowId, size: Option<f64>) -> Result<()> {
        if self.window_frame(id).is_none() {
            return Err(Error::new("No such window"));
        }
        self.window_new.entry(id).or_default().normal = Some(size);
        Ok(())
    }

    /// Gives a frame's windows their new pixel sizes along `horizontal`, as
    /// `window-resize-apply`, if they add up, with their new normal sizes;
    /// says whether they did.
    pub fn window_resize_apply(&mut self, frame: FrameId, horizontal: bool) -> bool {
        let Some(tree) = self.frame_tree(frame) else { return false };
        let root = tree.id();
        let (width, height) = self.frame_units_of(frame);
        let current = if horizontal { width } else { height };
        let new: std::collections::HashMap<WindowId, usize> =
            self.window_new.iter().filter_map(|(&id, n)| Some((id, usize::try_from(n.pixel?).ok()?))).collect();
        if new.get(&root).is_some_and(|&n| n != current) {
            return false;
        }
        let normals: std::collections::HashMap<WindowId, f64> = self.window_new.iter().filter_map(|(&id, n)| Some((id, n.normal??))).collect();
        let (cw, lh) = (self.cell().0, self.cell().1);
        let least = if horizontal { (2.0 * cw).round() } else { lh.round() } as usize;
        let tree = if frame == self.selected_frame { &mut self.window_tree } else { &mut self.other_frames.iter_mut().find(|f| f.id == frame).expect("found").tree };
        let applied = tree.apply_sizes(horizontal, current, least, &|id| new.get(&id).copied(), &|id| normals.get(&id).copied());
        if applied {
            self.relayout();
        }
        applied
    }

    /// Forgets the parameters of internal windows no frame has any more.
    pub(crate) fn prune_internal_windows(&mut self) {
        let mut ids: Vec<WindowId> = self.window_tree.ids();
        ids.extend(self.other_frames.iter().flat_map(|f| f.tree.ids()));
        self.internal_window_parameters.retain(|id, _| ids.contains(id));
        self.window_new.retain(|id, _| ids.contains(id));
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
            // Its buffer becomes current, as select-window's set_buffer makes it.
            let w = self.window_mut(id).expect("checked");
            w.used = used;
            let buffer = w.buffer;
            self.current = self.buffer_index(buffer);
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
                    let gone = frame.tree.remove(id);
                    for g in gone {
                        self.internal_window_parameters.remove(&g);
                    }
                    if frame.selected_window == id {
                        frame.selected_window = next.expect("another window");
                    }
                    self.forget_window(id);
                    self.prune_internal_windows();
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

    /// What a window's fringes are, as `set-window-fringes` set them.
    /// The widths are the front end's units; none means the frame's own.
    pub fn window_fringe_widths(&self, id: WindowId) -> (usize, usize, bool, bool) {
        let chrome = self.text_metrics().window_chrome();
        let (mut left, mut right) = (chrome.fringes / 2.0, chrome.fringes / 2.0);
        let (mut outside, mut persistent) = (false, false);
        if let Some(w) = self.window(id)
            && let Some(set) = &w.fringes
            && set.buffer.is_none_or(|b| b == w.buffer)
        {
            left = set.left.unwrap_or(left);
            right = set.right.unwrap_or(right);
            outside = set.outside_margins;
            persistent = set.buffer.is_none();
        }
        (left as usize, right as usize, outside, persistent)
    }

    /// Gives a window fringes of its own, as `set-window-fringes`: widths
    /// in the front end's units, none for the frame's own; `persistent`
    /// keeps them whatever buffer the window shows. True if they changed.
    pub fn set_window_fringes(&mut self, id: WindowId, left: Option<f32>, right: Option<f32>, outside_margins: bool, persistent: bool) -> bool {
        // Nothing on a terminal, as set_window_fringes returns at once
        // for a frame that is no window frame.
        if !self.text_metrics().fringes() {
            return false;
        }
        let (was_left, was_right, was_outside, _) = self.window_fringe_widths(id);
        let Some(w) = self.window(id) else { return false };
        let buffer = (!persistent).then_some(w.buffer);
        let fringes = WindowFringeWidths { buffer, left, right, outside_margins };
        // Fringes a window has no room for are left as they were, as
        // set_window_fringes leaves them.
        let room = self.window_pixel_rect(id).map_or(0.0, |r| r.width);
        let least = self.window_safe_min_units(true) as f32;
        let (want_left, want_right) = (left.unwrap_or(was_left as f32), right.unwrap_or(was_right as f32));
        if room - want_left - want_right < least {
            return false;
        }
        let Some(w) = self.window_mut(id) else { return false };
        w.fringes = Some(fringes);
        // Changed, as set-window-fringes says, when a width or the side
        // the margins are on did.
        let (now_left, now_right, now_outside, _) = self.window_fringe_widths(id);
        if (now_left, now_right, now_outside) == (was_left, was_right, was_outside) {
            return false;
        }
        self.relayout();
        true
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
        match self.window(id) {
            Some(w) => w.parameters.get(name),
            None => self.internal_window_parameters.get(&id)?.get(name),
        }
    }

    /// Sets a window's parameter, or with null takes it away, as `set-window-parameter`.
    pub fn set_window_parameter(&mut self, id: WindowId, name: &str, value: Value) -> Result<()> {
        if self.window(id).is_none() && self.window_internal_p(id) {
            let parameters = self.internal_window_parameters.entry(id).or_default();
            if value == Value::Null {
                parameters.remove(name);
            } else {
                parameters.insert(name.to_string(), value);
            }
            return Ok(());
        }
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
        let parameters = match self.window(id) {
            Some(w) => Some(&w.parameters),
            None => self.internal_window_parameters.get(&id),
        };
        parameters.map(|p| p.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
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
            let hscroll = self.hscroll_state(id);
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
            let (margins, fringes, scroll_bars) = self
                .window(id)
                .map(|w| (w.margins, w.fringes, w.scroll_bars.clone()))
                .unwrap_or_default();
            windows.push(SavedWindow { id, buffer, start, point, width, height, parameters, dedicated, prev_buffers, next_buffers, hscroll, margins, fringes, scroll_bars });
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
        let extras: Vec<_> = config
            .windows
            .iter()
            .map(|w| (w.parameters.clone(), w.dedicated.clone(), w.prev_buffers.clone(), w.next_buffers.clone(), w.hscroll, w.margins, w.fringes, w.scroll_bars.clone()))
            .collect();
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
        for ((id, buffer, start, point, width, height), (parameters, dedicated, prev, next, hscroll, margins, fringes, scroll_bars)) in saved.into_iter().zip(extras) {
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
            w.hscroll = crate::scroll::Hscroll { buffer, ..hscroll };
            (w.margins, w.fringes, w.scroll_bars) = (margins, fringes, scroll_bars);
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
        self.prune_internal_windows();
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

    /// How many window configurations the editor keeps, each with markers
    /// in buffers, until they are freed.
    pub fn window_configuration_count(&self) -> usize {
        self.window_configurations.len()
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
        if window == MINIBUFFER_WINDOW || self.window_tree.contains(window) {
            return Some(self.selected_frame);
        }
        self.other_frames.iter().find(|f| f.tree.contains(window)).map(|f| f.id)
    }

    /// A frame's root window: its only live window, or the internal window
    /// holding all its others, as Emacs's `frame-root-window`.
    pub fn frame_root_window(&self, frame: FrameId) -> Option<WindowId> {
        self.frame_tree(frame).map(WindowTree::id)
    }

    /// Whether a window is an internal window of some frame, as Emacs's
    /// `window-valid-p` is true and `window-live-p` false for one.
    pub fn window_internal_p(&self, id: WindowId) -> bool {
        self.window_frame(id).and_then(|f| self.frame_tree(f)).is_some_and(|t| t.combination_of(id).is_some())
    }

    /// A window's parent, the internal window it is a child of, as Emacs's `window-parent`.
    pub fn window_parent(&self, id: WindowId) -> Option<WindowId> {
        let tree = self.frame_tree(self.window_frame(id)?)?;
        tree.parent(id).map(|(c, _)| c.id)
    }

    /// An internal window's children, first to last, and whether they are
    /// side by side; none for a live window, as `window-top-child` and
    /// `window-left-child` find the first.
    pub fn window_children(&self, id: WindowId) -> Option<(bool, Vec<WindowId>)> {
        let tree = self.frame_tree(self.window_frame(id)?)?;
        let c = tree.combination_of(id)?;
        Some((c.horizontal, c.children.iter().map(|p| p.tree.id()).collect()))
    }

    /// The window after or before one in its parent, as Emacs's
    /// `window-next-sibling` and `window-prev-sibling`.
    pub fn window_sibling(&self, id: WindowId, next: bool) -> Option<WindowId> {
        let tree = self.frame_tree(self.window_frame(id)?)?;
        let (c, i) = tree.parent(id)?;
        let j = if next { i + 1 } else { i.checked_sub(1)? };
        c.children.get(j).map(|p| p.tree.id())
    }

    /// A window's share of its parent along its parent's combination, and
    /// across it, 1.0, as Emacs's `window-normal-size`; 1.0 for the root.
    pub fn window_normal_size(&self, id: WindowId, horizontal: bool) -> Option<f64> {
        let tree = self.frame_tree(self.window_frame(id)?)?;
        let Some((c, i)) = tree.parent(id) else { return Some(1.0) };
        if c.horizontal != horizontal {
            return Some(1.0);
        }
        Some(c.children[i].normal)
    }

    /// An internal window's combination limit, as `window-combination-limit`.
    pub fn window_combination_limit(&self, id: WindowId) -> Option<bool> {
        let tree = self.frame_tree(self.window_frame(id)?)?;
        tree.combination_of(id).map(|c| c.limit)
    }

    /// Sets an internal window's combination limit, as
    /// `set-window-combination-limit`: with it, splitting a child makes a
    /// new internal window rather than another child.
    pub fn set_window_combination_limit(&mut self, id: WindowId, limit: bool) -> Result<()> {
        let frame = self.window_frame(id).ok_or_else(|| Error::new("No such window"))?;
        let tree = if frame == self.selected_frame { &mut self.window_tree } else { &mut self.other_frames.iter_mut().find(|f| f.id == frame).expect("found").tree };
        let c = tree.combination_by_id_mut(id).ok_or_else(|| Error::signal("wrong-type-argument", "Not an internal window", Vec::new()))?;
        c.limit = limit;
        Ok(())
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
        if self.window_internal_p(id) {
            let (l, t, r, b) = self.window_edges(id, false)?;
            return Some((r - l, b - t));
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
        if let Some(r) = self.window_pixel_rect(id) {
            return Some((r.width, r.height));
        }
        let (cols, lines) = self.window_total_size(id)?;
        let m = self.text_metrics();
        Some((cols as f32 * m.char_width(), lines as f32 * m.char_height()))
    }

    /// A window's text area's size in the front end's units, what is left
    /// of it beside its mode line, header line, fringes and divider, as
    /// `window-body-width` and `window-body-height` with PIXELWISE.
    pub fn window_body_pixel_size(&self, id: WindowId) -> Option<(f32, f32)> {
        let r = self.window_pixel_rect(id)?;
        self.window(id)?;
        let (above, below, across) = self.window_chrome_units(id, &r);
        Some(((r.width - across).max(0.0), (r.height - above - below).max(0.0)))
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
        self.to_cells(self.frame_units_of(frame).0 as f32, true)
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
        // A lone window's size is the frame's, where no front end gave one.
        if self.frame_size_implied && matches!(self.window_tree, WindowTree::Leaf(_)) {
            self.frame_size = None;
            self.frame_size_implied = false;
        }
        let selected = self.selected_window;
        if let Some(w) = self.window_mut(selected) {
            w.height = lines.max(1);
        }
    }
}

/// The rest of window.c's tree for window.el: where a window sits on its
/// frame, what it was at the last redisplay, and the scroll bars and
/// dividers E8 draws none of (ADR 0077).
impl Editor {
    /// How far a window's left edge is from the frame's, in the front
    /// end's units, as `window-pixel-left`.
    pub fn window_pixel_left(&self, id: WindowId) -> Option<usize> {
        self.window_pixel_rect(id).map(|r| r.x.max(0.0) as usize)
    }

    /// How far a window's top edge is from the frame's, in the front
    /// end's units, as `window-pixel-top`.
    pub fn window_pixel_top(&self, id: WindowId) -> Option<usize> {
        self.window_pixel_rect(id).map(|r| r.y.max(0.0) as usize)
    }

    /// Which column of the frame a window starts at, as
    /// `window-left-column`.
    pub fn window_left_column(&self, id: WindowId) -> Option<usize> {
        self.window_edges(id, false).map(|(left, ..)| left)
    }

    /// Which line of the frame a window starts at, as `window-top-line`.
    pub fn window_top_line(&self, id: WindowId) -> Option<usize> {
        self.window_edges(id, false).map(|(_, top, ..)| top)
    }

    /// How tall a window's tab line is, as `window-tab-line-height`: none,
    /// E8 having no tab lines.
    pub fn window_tab_line_height(&self, _id: WindowId) -> usize {
        0
    }

    /// The width of the divider at a window's right or foot, as
    /// `window-right-divider-width` and `window-bottom-divider-width`:
    /// its frame's, which is 0 unless a parameter says otherwise.
    pub fn window_divider_width(&self, id: WindowId, bottom: bool) -> usize {
        let Some(frame) = self.window_frame(id) else { return 0 };
        // None for a window with nothing to its right, as Emacs's
        // WINDOW_RIGHT_DIVIDER_WIDTH is 0 for the rightmost.
        if !bottom && !self.window_pixel_rect(id).is_some_and(|r| r.divider) {
            return 0;
        }
        self.frame_divider_width(frame, bottom)
    }

    /// What a window's scroll bars are, as `window-scroll-bars`: the
    /// widths are 0 and the kinds what `set-window-scroll-bars` was told,
    /// E8 drawing none, as a terminal's window has none.
    pub fn window_scroll_bars(&self, id: WindowId) -> (usize, usize, Value, usize, usize, Value, bool) {
        let set = self.window(id).and_then(|w| w.scroll_bars.clone());
        // The kinds are the frame's by default, which Emacs says as `t`.
        let (vertical, horizontal, persistent) = set.unwrap_or((Value::Bool(true), Value::Bool(true), false));
        (0, 0, vertical, 0, 0, horizontal, persistent)
    }

    /// Says what a window's scroll bars should be, as
    /// `set-window-scroll-bars`. E8 draws none, so this is remembered and
    /// given back; true if what was remembered changed.
    pub fn set_window_scroll_bars(&mut self, id: WindowId, vertical: Value, horizontal: Value, persistent: bool) -> Result<bool> {
        // The kinds Emacs takes, as Fset_window_scroll_bars checks them.
        let kind = |value: &Value, kinds: &[&str], what: &str| match value {
            Value::Null | Value::Bool(_) => Ok(()),
            other => match other.as_str() {
                Some(name) if kinds.contains(&name) => Ok(()),
                _ => Err(Error::new(format!("Invalid type of {what} scroll bar"))),
            },
        };
        kind(&vertical, &["left", "right"], "vertical")?;
        kind(&horizontal, &["bottom"], "horizontal")?;
        let was = self.window(id).and_then(|w| w.scroll_bars.clone());
        let now = Some((vertical, horizontal, persistent));
        let Some(w) = self.window_mut(id) else { return Ok(false) };
        w.scroll_bars = now.clone();
        Ok(was != now)
    }

    /// The buffer a window showed at the last redisplay, as
    /// `window-old-buffer`, by name; none if it showed none.
    pub fn window_old_buffer(&self, id: WindowId) -> Option<String> {
        let old = self.window(id)?.old.as_ref()?.buffer;
        self.buffer_with_id(old).map(|index| self.buffers[index].name.clone())
    }

    /// Where point was in a window at the last redisplay, as
    /// `window-old-point`.
    pub fn window_old_point(&self, id: WindowId) -> Option<usize> {
        Some(self.window(id)?.old.as_ref()?.point)
    }

    /// How big a window was at the last redisplay, in the front end's
    /// units, as `window-old-pixel-width` and `-height`, and its text
    /// area's size, as `window-old-body-pixel-width` and `-height`.
    pub fn window_old_sizes(&self, id: WindowId) -> Option<((usize, usize), (usize, usize))> {
        let old = self.window(id)?.old.as_ref()?;
        Some((old.pixel, old.body))
    }

    /// The window that was selected at the last redisplay, as
    /// `old-selected-window`.
    pub fn old_selected_window(&self) -> Option<WindowId> {
        self.old_selected_window
    }

    /// A frame's selected window at the last redisplay, as
    /// `frame-old-selected-window`.
    pub fn frame_old_selected_window(&self, frame: FrameId) -> Option<WindowId> {
        self.old_frame_windows.get(&frame).copied()
    }

    /// Remembers what every window shows now, for the `*-old-*`
    /// accessors, as `run_window_change_functions` keeps it.
    pub(crate) fn remember_old_windows(&mut self) {
        let frames = self.frame_list();
        let mut olds = Vec::new();
        for frame in &frames {
            for view in self.frame_windows(*frame) {
                let id = view.id;
                let (buffer, point) = (view.buffer.id(), view.point);
                let pixel = self.window_pixel_size(id).map_or((0, 0), |(w, h)| (w as usize, h as usize));
                let body = self.window_body_pixel_size(id).map_or((0, 0), |(w, h)| (w as usize, h as usize));
                olds.push((id, OldWindow { buffer, point, pixel, body }));
            }
        }
        // Only a window that has none yet, or where something other than
        // point changed, is written down again: Emacs records them when
        // a window change happened, and moving point is not one, so
        // `window-old-point` keeps the point of the last change.
        let changed = olds.iter().any(|(id, now)| match self.window(*id).and_then(|w| w.old.as_ref()) {
            Some(old) => (old.buffer, old.pixel, old.body) != (now.buffer, now.pixel, now.body),
            None => true,
        }) || self.old_selected_window != Some(self.selected_window);
        if changed {
            for (id, old) in olds {
                if let Some(w) = self.window_mut(id) {
                    w.old = Some(old);
                }
            }
        }
        self.old_selected_window = Some(self.selected_window);
        for frame in &frames {
            if let Some(window) = self.frame_selected_window(*frame) {
                self.old_frame_windows.insert(*frame, window);
            }
        }
        self.old_frame_windows.retain(|frame, _| frames.contains(frame));
    }

    /// How wide a window's vertical scroll bar is, as
    /// `window-scroll-bar-width`, and how tall its horizontal one, as
    /// `window-scroll-bar-height`: none, E8 drawing no scroll bars.
    pub fn window_scroll_bar_size(&self, _id: WindowId, _horizontal: bool) -> usize {
        0
    }

    /// What a window's cursor looks like, as `window-cursor-type`: what
    /// `set-window-cursor-type` gave it, or nothing for its buffer's.
    pub fn window_cursor_type(&self, id: WindowId) -> Option<Value> {
        self.window(id).and_then(|w| w.cursor_type.clone())
    }

    /// Gives a window a cursor of its own, as `set-window-cursor-type`;
    /// nothing gives it back its buffer's.
    pub fn set_window_cursor_type(&mut self, id: WindowId, cursor: Value) -> Value {
        if let Some(w) = self.window_mut(id) {
            w.cursor_type = match cursor {
                Value::Null => None,
                value => Some(value),
            };
        }
        self.window_cursor_type(id).unwrap_or(Value::Null)
    }

    /// Runs `window-configuration-change-hook`, as
    /// `run-window-configuration-change-hook` does.
    pub fn run_window_configuration_change_hook(&mut self) -> Result<()> {
        self.run_hooks("window-configuration-change-hook")
    }

    /// The frame a window configuration was taken on, as
    /// `window-configuration-frame`.
    pub fn window_configuration_frame(&self, id: u64) -> Option<FrameId> {
        self.window_configurations.get(&id).map(|c| c.frame)
    }

    /// Whether two window configurations have the same windows showing
    /// the same buffers at the same places, as
    /// `window-configuration-equal-p`: what is current and the minibuffer
    /// are not compared, as `compare_window_configurations` leaves them out.
    pub fn window_configurations_equal(&self, a: u64, b: u64) -> bool {
        let (Some(a), Some(b)) = (self.window_configurations.get(&a), self.window_configurations.get(&b)) else {
            return false;
        };
        if a.frame != b.frame || a.tree != b.tree || a.selected != b.selected || a.windows.len() != b.windows.len() {
            return false;
        }
        // The buffer that was current counts, as compare_window_configurations
        // compares it; point, where each window starts and whether a
        // window is dedicated do not, which it leaves out.
        if a.current != b.current {
            return false;
        }
        a.windows.iter().zip(&b.windows).all(|(x, y)| {
            x.id == y.id && x.buffer == y.buffer && x.width == y.width && x.height == y.height && x.margins == y.margins && x.fringes == y.fringes && x.scroll_bars == y.scroll_bars
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rects(ed: &Editor) -> Vec<(WindowId, f32, f32, f32, f32, bool)> {
        let (cols, lines) = ed.frame_cells();
        ed.window_tree().rects(0.0, 0.0, cols as f32, lines as f32, (1.0, 1.0)).iter().map(|r| (r.id, r.x, r.y, r.width, r.height, r.divider)).collect()
    }

    #[test]
    fn splits_halve_and_odd_sizes_go_first() {
        let mut ed = Editor::new();
        ed.set_frame_size(81, 25);
        let below = ed.split_window(None, false).unwrap();
        let right = ed.split_window(None, true).unwrap();
        assert_eq!(ed.window_list(), [1, right, below]);
        assert_eq!(rects(&ed), [(1, 0.0, 0.0, 41.0, 13.0, true), (right, 41.0, 0.0, 40.0, 13.0, false), (below, 0.0, 13.0, 81.0, 12.0, false)]);
        ed.delete_window(Some(1)).unwrap();
        assert_eq!(ed.window_list(), [right, below]);
        ed.delete_window(Some(below)).unwrap();
        assert_eq!(*ed.window_tree(), WindowTree::Leaf(right));
    }

    #[test]
    fn a_split_before_puts_the_new_window_first_at_its_size() {
        let mut ed = Editor::new();
        ed.set_frame_size(80, 24);
        let new = ed.split_window_toward(None, true, true, Some(-30)).unwrap();
        assert_eq!(ed.window_list(), [new, 1]);
        assert_eq!(rects(&ed).iter().map(|r| (r.0, r.1, r.3)).collect::<Vec<_>>(), [(new, 0.0, 30.0), (1, 30.0, 50.0)]);
    }

    #[test]
    fn internal_windows_have_ids_parents_children_and_parameters() {
        let mut ed = Editor::new();
        ed.set_frame_size(80, 24);
        let below = ed.split_window(None, false).unwrap();
        let third = ed.split_window(Some(below), false).unwrap();
        let root = ed.frame_root_window(ed.selected_frame()).unwrap();
        assert!(ed.window_internal_p(root));
        assert_eq!(ed.window_children(root), Some((false, vec![1, below, third])));
        assert_eq!(ed.window_parent(third), Some(root));
        assert_eq!((ed.window_sibling(below, true), ed.window_sibling(below, false)), (Some(third), Some(1)));
        assert_eq!(ed.window_normal_size(1, false), Some(0.5));
        assert_eq!(ed.window_edges(root, false), Some((0, 0, 80, 24)));
        ed.set_window_parameter(root, "p", Value::Bool(true)).unwrap();
        assert_eq!(ed.window_parameter(root, "p"), Some(&Value::Bool(true)));
        // A parent's combination limit keeps it from being merged away; splitting a child still makes a sibling.
        ed.set_window_combination_limit(root, true).unwrap();
        let fourth = ed.split_window(Some(1), false).unwrap();
        assert_eq!(ed.window_parent(fourth), Some(root));
        // Deleting an internal window deletes the windows it holds.
        let right = ed.split_window(Some(third), true).unwrap();
        let inner = ed.window_parent(right).unwrap();
        assert_ne!(inner, root);
        ed.delete_window(Some(inner)).unwrap();
        assert!(!ed.window_list().contains(&right) && !ed.window_list().contains(&third));
    }

    #[test]
    fn a_window_beside_a_side_window_splits_into_an_internal_window_of_its_own() {
        let mut ed = Editor::new();
        ed.set_frame_size(80, 24);
        let side = ed.split_window(None, false).unwrap();
        ed.set_window_parameter(side, "window-side", Value::Symbol("bottom".into())).unwrap();
        let root = ed.frame_root_window(ed.selected_frame()).unwrap();
        let made = ed.split_window(Some(1), false).unwrap();
        assert_ne!(ed.window_parent(made), Some(root));
        assert_eq!(ed.window_parent(side), Some(root));
        assert!(ed.split_window(Some(side), true).is_err(), "a side window is not split");
    }
}
