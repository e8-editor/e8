//! Horizontal scrolling, as Emacs's window.c keeps it and xdisp.c's
//! `hscroll_windows` does it at redisplay ([ADR 0071]): each window is
//! scrolled some columns to the left, at least its `min-hscroll`, and
//! redisplay scrolls it to keep point in sight and out of
//! `hscroll-margin`, as `auto-hscroll-mode` says, unless a command set the
//! scroll since point last moved.
//!
//! [ADR 0071]: ../../../docs/adr/0071-scrolling-as-emacs-has-it.md

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::rows::Row;
use crate::variables::{Value, Variable};
use crate::window::WindowId;

/// How far a window is scrolled to the left, as window.c's `hscroll`,
/// `min_hscroll` and `suspend_auto_hscroll`, for the buffer it showed when
/// they were set: showing another buffer starts again from 0, as
/// `set-window-buffer` resets them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Hscroll {
    pub(crate) buffer: u64,
    /// Columns scrolled off the left edge.
    pub(crate) columns: usize,
    /// The least automatic scrolling leaves, as `scroll-left` sets it.
    pub(crate) min: usize,
    /// Whether automatic scrolling waits until point moves, after a
    /// command set the scroll.
    pub(crate) suspended: bool,
    /// Where point was at the last redisplay, to tell when it moves.
    pub(crate) old_point: Option<usize>,
}

pub(crate) fn define_variables(ed: &mut Editor) {
    ed.define_hook(
        "window-scroll-functions",
        "Functions redisplay calls with a window and its new start when the window is about to show its buffer from somewhere else, as when it scrolls or shows another buffer.",
    );
    for var in [
        Variable::new(
            "auto-hscroll-mode",
            "Whether redisplay scrolls windows horizontally to keep point in sight.\n\nnil leaves the scroll as it is, `current-line' scrolls only the line point is on, and any other non-nil value the whole window.",
            true,
        ),
        Variable::new(
            "hscroll-margin",
            "How many columns away from a window's left or right edge point may come before redisplay scrolls the window horizontally.",
            5.0,
        ),
        Variable::new(
            "hscroll-step",
            "How far redisplay scrolls a window horizontally when point comes too near an edge.\n\nAn integer is that many columns; a float between 0 and 1 that fraction of the window's width; 0 puts point in the middle of the window.",
            0.0,
        ),
    ] {
        ed.define_variable(var);
    }
}

impl Editor {
    /// A window's horizontal scroll, as it is for the buffer it shows.
    pub(crate) fn hscroll_state(&self, window: WindowId) -> Hscroll {
        let Some(w) = self.window(window) else { return Hscroll::default() };
        if w.hscroll.buffer == w.buffer { w.hscroll } else { Hscroll { buffer: w.buffer, ..Hscroll::default() } }
    }

    fn set_hscroll_state(&mut self, window: WindowId, state: Hscroll) {
        if let Some(w) = self.window_mut(window) {
            w.hscroll = Hscroll { buffer: w.buffer, ..state };
        }
    }

    /// How many columns a window is scrolled to the left, as Emacs's
    /// `window-hscroll`.
    pub fn window_hscroll(&self, window: WindowId) -> usize {
        self.hscroll_state(window).columns
    }

    /// Scrolls a window `columns` to the left, as Emacs's
    /// `set-window-hscroll`: a negative number is 0. Automatic scrolling
    /// waits until point moves. Returns the scroll.
    pub fn set_window_hscroll(&mut self, window: WindowId, columns: i64) -> usize {
        let mut state = self.hscroll_state(window);
        state.columns = columns.max(0) as usize;
        state.suspended = true;
        self.set_hscroll_state(window, state);
        state.columns
    }

    /// Scrolls the selected window `columns` further left, or right for a
    /// negative number, as Emacs's `scroll-left`. With `set_minimum`, the
    /// scroll it leaves is the least automatic scrolling may leave. Returns
    /// the scroll.
    pub fn scroll_left(&mut self, columns: i64, set_minimum: bool) -> usize {
        let window = self.selected_window;
        let now = self.window_hscroll(window) as i64;
        let scroll = self.set_window_hscroll(window, now.saturating_add(columns));
        if set_minimum {
            let mut state = self.hscroll_state(window);
            state.min = scroll;
            self.set_hscroll_state(window, state);
        }
        scroll
    }

    /// How many columns a window's body is wide, line numbers included.
    pub(crate) fn window_body_columns(&self, window: WindowId) -> usize {
        self.window(window).map_or(80, |w| w.width)
    }

    /// Whether a window showing a buffer scrolls only the line point is
    /// on, as xdisp.c's `hscrolling_current_line_p`.
    fn hscrolling_current_line(&self, b: &Buffer, state: Hscroll) -> bool {
        !state.suspended && matches!(self.variable_in(b, "auto-hscroll-mode"), Some(Value::Str(s) | Value::Symbol(s)) if s == "current-line")
    }

    /// How many columns a row of a window is scrolled to the left: the
    /// window's scroll, or with `auto-hscroll-mode` set to `current-line`,
    /// its least on every row but point's. Right-to-left rows are not
    /// scrolled.
    pub fn row_hscroll(&self, window: WindowId, row: &Row, point: usize) -> usize {
        let state = self.hscroll_state(window);
        if row.right_to_left {
            return 0;
        }
        if state.columns == state.min || row.shows_point(point) {
            return state.columns;
        }
        let Some(b) = self.buffer_with_id(state.buffer).map(|i| &self.buffers[i]) else { return state.columns };
        if self.hscrolling_current_line(b, state) { state.min } else { state.columns }
    }

    /// Keeps a scroll a command set while a vertical scroll moves point,
    /// as window.c's window_scroll moves `old_pointm` with point, so that
    /// `C-v` does not undo `set-window-hscroll`.
    fn scrolled_vertically(&self) -> bool {
        self.last_command().is_some_and(|c| VERTICAL_SCROLLS.contains(&c))
    }

    /// Whether a window's lines are truncated because it is scrolled.
    pub(crate) fn hscrolled(&self, window: WindowId) -> bool {
        self.window_hscroll(window) > 0
    }

    /// Scrolls every window horizontally to keep point in sight, as
    /// xdisp.c's `hscroll_window_tree`: when point's row is cut off at the
    /// right and point is within `hscroll-margin` of the right edge, or the
    /// window is scrolled and point is within it of the left. Returns
    /// whether any window's scroll changed.
    pub(crate) fn hscroll_windows(&mut self) -> bool {
        let step = match self.variable("hscroll-step") {
            Some(Value::Number(n)) if n.fract() != 0.0 && (0.0..1.0).contains(&n) => Step::Fraction(n as f32),
            Some(Value::Number(n)) if n.fract() == 0.0 && n > 0.0 => Step::Columns(n as f32),
            _ => Step::Centre,
        };
        let margin = self.variable("hscroll-margin").and_then(|v| v.as_number()).unwrap_or(5.0).clamp(0.0, 1_000_000.0).floor() as f32;
        let windows: Vec<(WindowId, usize)> = self.window_views().into_iter().map(|v| (v.id, v.point)).collect();
        let mut changed = false;
        for (window, point) in windows {
            changed |= self.hscroll_window(window, point, step, margin);
        }
        changed
    }

    fn hscroll_window(&mut self, window: WindowId, point: usize, step: Step, margin: f32) -> bool {
        let mut state = self.hscroll_state(window);
        // A scroll a command set lasts until point moves, other than by scrolling.
        if state.suspended && state.old_point.is_some_and(|old| old != point) && !self.scrolled_vertically() {
            state.suspended = false;
        }
        state.old_point = Some(point);
        self.set_hscroll_state(window, state);
        let Some(b) = self.buffer_with_id(state.buffer).map(|i| &self.buffers[i]) else { return false };
        if !self.variable_in(b, "auto-hscroll-mode").is_some_and(|v| v.is_true()) || state.suspended {
            return false;
        }
        let wrap = self.wrap_in(window, b);
        // Lines that wrap are never cut off, and unscrolled stay so.
        if wrap.is_some() && state.columns == 0 && state.min == 0 {
            return false;
        }
        // Point's line, styled, as fonts decide its width.
        let rows = self.rows_from(b, self.row_line_in(b, b.line_of(point)), usize::MAX, 1, Some(true), wrap);
        let tab_width = self.tab_width_in(b);
        let Some(k) = crate::display::row_showing(&rows, point, tab_width) else { return false };
        let row = &rows[k];
        if row.right_to_left {
            return false;
        }
        let glyphs = crate::display::row_glyphs(row, tab_width);
        let columns = self.glyph_columns(row, &glyphs, tab_width);
        let index = crate::display::cursor_glyph(row, &glyphs, point);
        // Where point is in its line, unscrolled, and in the window.
        let point_x: f32 = columns[..index].iter().sum();
        let row_width: f32 = columns.iter().sum();
        // Only where point shows, as Emacs needs the cursor in the window.
        if window != self.selected_window && !self.pos_visible_in_window_p(point, window, true) {
            return false;
        }
        let current_line = self.hscrolling_current_line(b, state);
        let shown = self.row_hscroll(window, row, point) as f32;
        let cursor_x = point_x - shown;
        // As Emacs's text area, line numbers included, and where text starts in it.
        let numbers = self.line_number_columns(window, b) as f32;
        let width = self.text_area_columns(window) + numbers;
        let terminal = !self.metrics.fringes();
        let cut_left = shown > 0.0 && !glyphs.is_empty();
        // A terminal's `$` at the left takes the first column's place.
        let x_offset = if cut_left && terminal { -1.0 } else { 0.0 };
        // A terminal keeps the last column for its `$`.
        let cut_right = row_width > shown + width - numbers - if terminal { 1.0 } else { 0.0 };
        let wants = (state.columns > 0 && cursor_x <= margin + x_offset)
            || (cut_right && cursor_x >= width - numbers - margin)
            || (current_line && state.columns != state.min && !cut_left);
        if !wants {
            return false;
        }
        // Line numbers come before text in sight only.
        let x = if point_x >= shown { point_x + numbers } else { point_x };
        let at_end_of_line = b.char_at(point).is_none_or(|c| c == '\n');
        let wanted = match step {
            Step::Centre => {
                let half = if self.metrics.uniform() { (width as usize / 2) as f32 } else { width / 2.0 };
                if at_end_of_line { width - 4.0 } else { half }
            }
            _ if cursor_x >= width - numbers - margin => match step {
                Step::Fraction(f) => width * (1.0 - f) - margin,
                Step::Columns(n) => width - n - margin,
                Step::Centre => unreachable!(),
            },
            Step::Fraction(f) => width * f + margin + numbers + x_offset,
            Step::Columns(n) => n + margin + numbers + x_offset,
        };
        let scroll = ((x - wanted).max(0.0).floor() as usize).max(state.min);
        if scroll == state.columns {
            return false;
        }
        state.columns = scroll;
        self.set_hscroll_state(window, state);
        true
    }

    /// Runs `window-scroll-functions` for a window with its start, as
    /// Emacs's `run-window-scroll-functions`.
    pub fn run_window_scroll_functions(&mut self, window: WindowId) -> crate::error::Result<()> {
        let Some(start) = self.window_start(window) else { return Ok(()) };
        if let Some(w) = self.window_mut(window) {
            w.scrolled_to = Some((w.buffer, start));
        }
        self.run_hook_with_args("window-scroll-functions", &[Value::Window(window), Value::Number(start as f64)])
    }

    /// Runs `window-scroll-functions` for each window whose buffer or
    /// start changed since it last ran, as redisplay does in Emacs.
    pub(crate) fn run_scroll_functions_where_moved(&mut self) {
        let moved: Vec<WindowId> = self
            .window_views()
            .into_iter()
            .filter(|v| self.window(v.id).and_then(|w| w.scrolled_to) != self.window_start(v.id).map(|s| (v.buffer.id(), s)))
            .map(|v| v.id)
            .collect();
        for window in moved {
            if let Err(e) = self.run_window_scroll_functions(window) {
                self.message(format!("Error in window-scroll-functions: {e}"));
            }
        }
    }

    /// Every frame's windows.
    fn window_views(&self) -> Vec<crate::window::WindowView<'_>> {
        self.frame_list().into_iter().flat_map(|f| self.frame_windows(f)).collect()
    }
}

/// The commands that scroll a window vertically, which keep a scroll set
/// by a command though they move point.
const VERTICAL_SCROLLS: &[&str] = &[
    "scroll-up-command",
    "scroll-down-command",
    "scroll-up",
    "scroll-down",
    "scroll-up-line",
    "scroll-down-line",
    "mwheel-scroll",
    "scroll-other-window",
    "scroll-other-window-down",
];

/// How far automatic scrolling goes, as `hscroll-step` says.
#[derive(Clone, Copy)]
enum Step {
    /// Point to the middle of the window.
    Centre,
    Columns(f32),
    Fraction(f32),
}
