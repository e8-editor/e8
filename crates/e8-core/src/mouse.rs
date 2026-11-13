//! The mouse as values, as Emacs's frame.c, window.c and keyboard.c give
//! it ([ADR 0074]): where the pointer is (`mouse-position`), moving it
//! (`set-mouse-position`), which window and which part of it a place on
//! the frame is (`window-at`, `coordinates-in-window-p`), and
//! `<mouse-movement>` events while `track-mouse` is on.
//!
//! The front ends know where the pointer is, and write it into a cell the
//! editor reads when asked, so moving the mouse costs the editor nothing
//! until code wants to know; they send movement as events only while
//! `track-mouse` says so, as Emacs generates them only then. Places are in
//! the front end's units from the top left of the frame's windows, as
//! `window-pixel-edges` gives them, so `window-at` of `mouse-position` is
//! the window under the pointer.
//!
//! [ADR 0074]: ../../../docs/adr/0074-mouse-events-as-emacs-has-them.md

use std::sync::{Arc, Mutex};

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::key::{Key, KeyCode};
use crate::window::{FrameId, MINIBUFFER_WINDOW, MouseEvent, WindowId};

pub(crate) fn define_variables(ed: &mut Editor) {
    use crate::variables::{Value, Variable};
    for var in [
        Variable::new(
            "track-mouse",
            "Non-nil means generate <mouse-movement> events as the mouse moves, as the track-mouse macro binds it.",
            Value::Null,
        ),
        Variable::new(
            "mouse-position-function",
            "If non-nil, a function mouse-position and mouse-pixel-position call with what they would return, returning what it returns.",
            Value::Null,
        ),
    ] {
        ed.define_variable(var);
    }
}

/// Where the pointer is over one of the editor's frames, as a front end
/// last saw it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer {
    pub frame: FrameId,
    /// From the top left of the frame's windows, in the front end's units:
    /// points in a window, cells on a terminal.
    pub x: f32,
    pub y: f32,
    /// Where it is on the screen, in the same units, if the front end knows.
    pub screen: Option<(f32, f32)>,
}

/// Where the front ends write the pointer's place, and the editor reads it.
pub type PointerCell = Arc<Mutex<Option<Pointer>>>;

/// Forgets the pointer's place if it is over `frame`.
pub(crate) fn left(cell: &PointerCell, frame: FrameId) {
    let mut pointer = cell.lock().unwrap_or_else(|e| e.into_inner());
    if pointer.is_some_and(|p| p.frame == frame) {
        *pointer = None;
    }
}

/// A request to move the pointer, as `set-mouse-position` makes, for the
/// front end.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Warp {
    /// To a place on a frame, from the top left of its windows: in the
    /// front end's units, or with `chars`, the middle of the character
    /// cell at that column and line, as Emacs's frame_char_to_pixel_position.
    Frame { frame: FrameId, x: f32, y: f32, chars: bool },
    /// To a place on the screen.
    Screen { x: f32, y: f32 },
}

/// Which part of a window a place is on, as Emacs's
/// `coordinates-in-window-p` answers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WindowPart {
    /// Over the text, this far from the window's top left in columns and
    /// lines, its header line counted, as Emacs measures it.
    Text(f64, f64),
    ModeLine,
    HeaderLine,
    /// On the border between the window and the one to its right.
    VerticalLine,
    LeftFringe,
    RightFringe,
    LeftMargin,
    RightMargin,
}

impl WindowPart {
    /// The symbol Emacs returns for it; text is a pair of numbers instead.
    pub fn name(self) -> Option<&'static str> {
        Some(match self {
            WindowPart::Text(..) => return None,
            WindowPart::ModeLine => "mode-line",
            WindowPart::HeaderLine => "header-line",
            WindowPart::VerticalLine => "vertical-line",
            WindowPart::LeftFringe => "left-fringe",
            WindowPart::RightFringe => "right-fringe",
            WindowPart::LeftMargin => "left-margin",
            WindowPart::RightMargin => "right-margin",
        })
    }
}

impl Editor {
    /// The cell the front end writes the pointer's place into.
    pub fn pointer_cell(&self) -> PointerCell {
        self.pointer.clone()
    }

    /// Reads the pointer's place from `cell`, which a front end writes, as
    /// the driver gives the editor the cell it made.
    pub fn set_pointer_cell(&mut self, cell: PointerCell) {
        self.pointer = cell;
    }

    /// Says where the pointer is, or that it is over none of the editor's
    /// frames, as a front end does when it moves.
    pub fn set_pointer(&self, pointer: Option<Pointer>) {
        *self.pointer.lock().unwrap_or_else(|e| e.into_inner()) = pointer;
    }

    /// The pointer left `frame`'s window: it is over none of the editor's
    /// frames, unless a front end has already seen it over another.
    pub fn pointer_left(&self, frame: FrameId) {
        left(&self.pointer, frame);
    }

    /// Where the pointer is, if it is over a live frame.
    fn pointer(&self) -> Option<Pointer> {
        let pointer = *self.pointer.lock().unwrap_or_else(|e| e.into_inner());
        pointer.filter(|p| self.frame_list().contains(&p.frame))
    }

    /// The frame the pointer is over and where on it, in the front end's
    /// units, as Emacs's `mouse-pixel-position`: the selected frame and
    /// nothing if no front end has said.
    pub fn mouse_pixel_position(&self) -> (FrameId, Option<(i64, i64)>) {
        match self.pointer() {
            Some(p) => (p.frame, Some((p.x.floor() as i64, p.y.floor() as i64))),
            None => (self.selected_frame(), None),
        }
    }

    /// The frame the pointer is over and the column and line it is at, as
    /// Emacs's `mouse-position`, counting from the frame's windows' top
    /// left as `window-edges` does, negative above or left of it.
    pub fn mouse_position(&self) -> (FrameId, Option<(i64, i64)>) {
        let (cw, lh) = self.cell();
        match self.pointer() {
            Some(p) => (p.frame, Some(((p.x / cw).floor() as i64, (p.y / lh).floor() as i64))),
            None => (self.selected_frame(), None),
        }
    }

    /// Where the pointer is on the screen, if a front end knows, as
    /// `mouse-absolute-pixel-position`.
    pub fn mouse_absolute_pixel_position(&self) -> Option<(i64, i64)> {
        let p = (*self.pointer.lock().unwrap_or_else(|e| e.into_inner()))?;
        p.screen.map(|(x, y)| (x.floor() as i64, y.floor() as i64))
    }

    /// Moves the pointer to the middle of the character cell at column `x`
    /// and line `y` of `frame`, as Emacs's `set-mouse-position`. A window
    /// moves it; a terminal cannot, and selects the frame instead, as Emacs
    /// on a terminal without GPM does.
    pub fn set_mouse_position(&mut self, frame: FrameId, x: i64, y: i64) -> Result<()> {
        self.warp_on(frame, x as f32, y as f32, true)
    }

    /// Moves the pointer to `x` and `y` in the front end's units on
    /// `frame`, as Emacs's `set-mouse-pixel-position`.
    pub fn set_mouse_pixel_position(&mut self, frame: FrameId, x: i64, y: i64) -> Result<()> {
        self.warp_on(frame, x as f32, y as f32, false)
    }

    fn warp_on(&mut self, frame: FrameId, x: f32, y: f32, chars: bool) -> Result<()> {
        if !self.frame_list().contains(&frame) {
            return Err(Error::signal("wrong-type-argument", "Wrong type argument: frame-live-p", Vec::new()));
        }
        if !self.text_metrics().images() {
            return self.select_frame(frame);
        }
        // Where the pointer goes, as frame_char_to_pixel_position puts it:
        // the middle of the cell, kept on the frame.
        let (x, y) = if chars {
            let (cw, lh) = self.cell();
            // The whole frame, its minibuffer's lines too, as FRAME_PIXEL_HEIGHT.
            let (width, height) = self.frame_units_of(frame);
            let height = height as f32 + self.mini_window_lines() as f32 * lh;
            ((x * cw + (cw / 2.0).floor()).clamp(0.0, width as f32), (y * lh + (lh / 2.0).floor()).clamp(0.0, height))
        } else {
            (x, y)
        };
        self.warps.push(Warp::Frame { frame, x, y, chars: false });
        // Known at once, as the window system reports the pointer where it was put.
        let screen = self.pointer().filter(|p| p.frame == frame).and_then(|p| p.screen.map(|(sx, sy)| (sx - p.x + x, sy - p.y + y)));
        self.set_pointer(Some(Pointer { frame, x, y, screen }));
        Ok(())
    }

    /// Moves the pointer to `x` and `y` on the screen, as
    /// `set-mouse-absolute-pixel-position`: only a window can.
    pub fn set_mouse_absolute_pixel_position(&mut self, x: i64, y: i64) {
        if self.text_metrics().images() {
            self.warps.push(Warp::Screen { x: x as f32, y: y as f32 });
        }
    }

    /// The pointer moves code asked for since the front end last looked.
    pub fn take_warps(&mut self) -> Vec<Warp> {
        std::mem::take(&mut self.warps)
    }

    /// Whether `<mouse-movement>` events are wanted, as `track-mouse` says.
    pub fn tracking_mouse(&self) -> bool {
        self.variable("track-mouse").is_some_and(|v| v.is_true())
    }

    /// The pointer moved to where `event` says. While `track-mouse` is on
    /// this is a `<mouse-movement>` event, run like any key; otherwise
    /// nothing, as Emacs generates none then.
    pub fn mouse_moved(&mut self, event: MouseEvent) {
        if self.tracking_mouse() {
            self.mouse(Key::new(KeyCode::MouseMovement), event);
        }
    }

    /// The window at column `x` and line `y` of `frame`, from the top left
    /// of its windows, and the part of it there, as Emacs's `window-at`
    /// finds it: the frame's windows in order, then its minibuffer's.
    pub fn window_at(&self, x: f64, y: f64, frame: FrameId) -> Option<(WindowId, WindowPart)> {
        let (ux, uy) = self.canon_to_units(x, y);
        let mut windows: Vec<WindowId> = self.frame_windows(frame).iter().map(|v| v.id).collect();
        if self.window_frame(MINIBUFFER_WINDOW) == Some(frame) {
            windows.push(MINIBUFFER_WINDOW);
        }
        windows.into_iter().find_map(|w| self.part_at(w, ux, uy).map(|part| (w, part)))
    }

    /// Which part of `window` is at column `x` and line `y` of its frame,
    /// or none if the place is not in it, as Emacs's
    /// `coordinates-in-window-p`.
    pub fn coordinates_in_window(&self, x: f64, y: f64, window: WindowId) -> Option<WindowPart> {
        let (ux, uy) = self.canon_to_units(x, y);
        self.part_at(window, ux, uy)
    }

    /// Columns and lines as the front end's units, whole ones, truncated
    /// toward zero as Emacs's FRAME_PIXEL_X_FROM_CANON_X truncates them.
    fn canon_to_units(&self, x: f64, y: f64) -> (f32, f32) {
        let (cw, lh) = self.cell();
        ((x * cw as f64).trunc() as f32, (y * lh as f64).trunc() as f32)
    }

    /// The part of a window at a place in its frame's units, as window.c's
    /// coordinates_in_window: E8 has no window dividers or scroll bars, its
    /// fringes are outside its margins, and on a terminal a window with one
    /// to its right gives its last column to the border between them.
    fn part_at(&self, window: WindowId, x: f32, y: f32) -> Option<WindowPart> {
        let rect = self.window_pixel_rect(window)?;
        let frame = self.window_frame(window)?;
        let (cw, lh) = self.cell();
        let graphic = self.text_metrics().images();
        let (left, top, right, bottom) = (rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
        if y < top || y >= bottom || x < left || x >= right {
            return None;
        }
        let rightmost = right + 0.5 >= self.frame_units_of(frame).0 as f32;
        let chrome = self.text_metrics().window_chrome();
        let minibuffer = window == MINIBUFFER_WINDOW;
        let lines = self.window_total_size(window).map_or(0, |(_, lines)| lines);
        let mode_line = !minibuffer && self.window_shows_mode_line(window);
        let header_line = !minibuffer && self.window_wants_header_line(window, lines);
        let on_bar = if mode_line && y >= bottom - chrome.mode_line {
            Some(WindowPart::ModeLine)
        } else if header_line && y < top + chrome.header_line {
            Some(WindowPart::HeaderLine)
        } else {
            None
        };
        if let Some(part) = on_bar {
            // Over the border at the bar's end, so windows can be resized there.
            return Some(if !rightmost && (x - right).abs() < cw { WindowPart::VerticalLine } else { part });
        }
        // The rightmost unit, as Emacs's WINDOW_BOX_RIGHT_EDGE_X - 1.
        let box_right = right - 1.0;
        if !rightmost && if graphic { (x - box_right).abs() < cw } else { x > box_right - cw } {
            return Some(WindowPart::VerticalLine);
        }
        let (lmargin, rmargin) = if minibuffer { (0, 0) } else { self.window_margins(window) };
        let (lmargin, rmargin) = (lmargin as f32 * cw, rmargin as f32 * cw);
        let fringe = if minibuffer { 0.0 } else { chrome.fringes / 2.0 };
        let divider = if rect.divider { chrome.divider } else { 0.0 };
        // [fringe][margin][text][margin][fringe], as the front ends lay it out.
        let text_left = left + fringe + lmargin;
        let text_right = (right - divider - fringe - rmargin).max(text_left);
        if x < text_left {
            return Some(if lmargin > 0.0 && x >= left + fringe { WindowPart::LeftMargin } else { WindowPart::LeftFringe });
        }
        if x >= text_right {
            return Some(if rmargin > 0.0 && x < text_right + rmargin { WindowPart::RightMargin } else { WindowPart::RightFringe });
        }
        let (rx, ry) = ((x - text_left) as f64 / cw as f64, (y - top) as f64 / lh as f64);
        // A terminal's are whole cells, as Emacs's are with a column width of 1.
        Some(if graphic { WindowPart::Text(rx, ry) } else { WindowPart::Text(rx.floor(), ry.floor()) })
    }
}
